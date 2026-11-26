import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DataSource, EntityManager, In, IsNull, MoreThan, Not } from 'typeorm';
import { TelegramBotDailyUsage } from '../common/entities/telegram-bot-daily-usage.entity';
import { TelegramBotInboundTask as Task } from '../common/entities/telegram-bot-inbound-task.entity';
import { TelegramBotUserBan } from '../common/entities/telegram-bot-user-ban.entity';
import { TelegramBotWhitelist } from '../common/entities/telegram-bot-whitelist.entity';
import { databaseRawQuery, isSqliteBusy } from '../database/database-types';
import type { IssuedGrant } from './telegram-bot-grant.service';

export type EnqueueInboundTask = Pick<Task, 'receiverBotId' | 'sourceAccountId' | 'telegramUserId'
  | 'telegramUsername' | 'telegramDisplayName' | 'chatId' | 'messageId' | 'telegramFileId'
  | 'fileUniqueId' | 'fileName' | 'mimeType' | 'fileSize' | 'usageDate'> & { dailyLimit: number };

export type EnqueueInboundResult =
  | { status: 'queued' | 'duplicate'; task: Task; used: number }
  | { status: 'quota_denied' | 'banned'; used: number };

export interface InboundNotice {
  task: Task;
  /** One-based position including any currently transferring file; zero for all non-queued states. */
  position: number;
}

const LEASE_MS = 30_000;

@Injectable()
export class TelegramBotInboundQueueService implements OnApplicationShutdown {
  private sqliteDb?: Promise<DataSource>;
  private sqliteWriter = Promise.resolve();

  constructor(private readonly db: DataSource) {}

  private get dialect() { return this.db.options.type === 'better-sqlite3' ? 'sqlite' : 'postgres'; }

  /** Keep transactions isolated from unrelated requests sharing TypeORM's SQLite connection. */
  private transaction<T>(action: (manager: EntityManager) => Promise<T>): Promise<T> {
    const options = this.db.options;
    if (options.type !== 'better-sqlite3') return this.db.transaction(action);
    const run = async () => {
      let db = this.db;
      if (options.database !== ':memory:') {
        this.sqliteDb ??= new DataSource({
          ...options, timeout: 0, migrations: [], migrationsRun: false, synchronize: false, dropSchema: false,
        }).initialize().catch(error => { this.sqliteDb = undefined; throw error; });
        db = await this.sqliteDb;
      }
      const deadline = Date.now() + (options.timeout ?? 5000);
      for (;;) {
        try {
          return await db.transaction(async manager => {
            // Take the write lock before reading; no TOCTOU window for first-time users.
            await manager.query('UPDATE telegram_bot_inbound_tasks SET status = status WHERE 0');
            return action(manager);
          });
        } catch (error) {
          if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
          await delay(Math.min(25, Math.max(1, deadline - Date.now())));
        }
      }
    };
    const result = this.sqliteWriter.then(run);
    this.sqliteWriter = result.then(() => {}, () => {});
    return result;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.sqliteWriter;
    if (this.sqliteDb) await (await this.sqliteDb).destroy();
  }

  private async lock(manager: EntityManager, key: string): Promise<void> {
    if (this.dialect === 'postgres') {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    }
  }

  withUserLock<T>(userId: string, action: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.transaction(async manager => {
      await this.lock(manager, 'bot-user:' + userId);
      return action(manager);
    });
  }

  withUnbannedUser<T>(userId: string, action: (manager: EntityManager) => Promise<T>): Promise<T | null> {
    return this.withUserLock(userId, async manager =>
      await manager.existsBy(TelegramBotUserBan, { telegramUserId: userId }) ? null : action(manager));
  }

  isBanned(telegramUserId: string): Promise<boolean> {
    return this.db.manager.existsBy(TelegramBotUserBan, { telegramUserId });
  }

  findByMessage(receiverBotId: string, chatId: string, messageId: string): Promise<Task | null> {
    return this.db.manager.findOneBy(Task, { receiverBotId, chatId, messageId });
  }

  enqueue(
    input: EnqueueInboundTask,
    onQueued?: (manager: EntityManager, task: Task) => Promise<void>,
  ): Promise<EnqueueInboundResult> {
    const { dailyLimit, ...source } = input;
    const { receiverBotId, telegramUserId, chatId, messageId, usageDate } = source;
    return this.withUserLock(telegramUserId, async manager => {
      if (await manager.existsBy(TelegramBotUserBan, { telegramUserId })) return { status: 'banned', used: 0 };
      // A newly assigned FIFO position becomes visible before a worker can claim a later one.
      await this.lock(manager, 'inbound-bot:' + receiverBotId);
      const existing = await manager.findOneBy(Task, { receiverBotId, telegramUserId, chatId, messageId });
      if (existing) return { status: 'duplicate', task: existing, used: existing.quotaUsed };
      const whitelisted = await manager.existsBy(TelegramBotWhitelist, { telegramUserId, enabled: true });
      const usageKey = { telegramUserId, usageDate };
      const now = new Date();
      if (!whitelisted) {
        await manager.createQueryBuilder().insert().into(TelegramBotDailyUsage).values({
          ...usageKey, id: randomUUID(), issuedCount: 0, createdAt: now, updatedAt: now,
        }).orIgnore().execute();
        // The same usage row is also used by the Telegram-storage path.
        const charge = await manager.createQueryBuilder().update(TelegramBotDailyUsage)
          .set({ issuedCount: () => '"issuedCount" + 1', updatedAt: now })
          .where(usageKey).andWhere('"issuedCount" < :limit', { limit: dailyLimit }).execute();
        if (!charge.affected) {
          const usage = await manager.findOneByOrFail(TelegramBotDailyUsage, usageKey);
          return { status: 'quota_denied', used: usage.issuedCount };
        }
      }
      const used = (await manager.findOneBy(TelegramBotDailyUsage, usageKey))?.issuedCount ?? 0;
      const task = await manager.save(Task, manager.create(Task, {
        ...source, id: randomUUID(), status: 'queued', quotaConsumed: !whitelisted, quotaUsed: used,
        createdAt: now, updatedAt: now,
      }));
      await onQueued?.(manager, task);
      return { status: 'queued', task, used };
    });
  }

  private lockedTask(manager: EntityManager, id: string): Promise<Task | null> {
    return manager.findOne(Task, { where: { id },
      ...(this.dialect === 'postgres' ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
  }

  async claimNext(receiverBotId: string): Promise<Task | null> {
    if (!await this.db.manager.existsBy(Task, { receiverBotId, status: In(['queued', 'running']) })) return null;
    return this.transaction(async manager => {
      await this.lock(manager, 'inbound-bot:' + receiverBotId);
      const lock = this.dialect === 'postgres' ? { lock: { mode: 'pessimistic_write' as const } } : {};
      const now = new Date();
      if (await manager.existsBy(Task, { receiverBotId, botCooldownUntil: MoreThan(now) })) return null;
      const leased = await manager.findOne(Task, { where: { receiverBotId, leaseToken: Not(IsNull()) }, ...lock });
      if (leased?.leaseExpiresAt && leased.leaseExpiresAt > now) return null;
      if (leased?.status === 'cancelled') {
        await manager.update(Task, { id: leased.id }, { leaseToken: null, leaseExpiresAt: null });
      }
      // A delayed head (e.g. Telegram 429) retains its place. Expired running jobs restart first.
      const head = leased?.status === 'running' ? leased : await manager.findOne(Task, {
        where: { receiverBotId, status: 'queued' }, order: { sequence: 'ASC' }, ...lock,
      });
      if (!head || (head.availableAt && head.availableAt > now)) return null;
      return manager.save(Task, Object.assign(head, {
        status: 'running', startedAt: head.startedAt ?? now, updatedAt: now, availableAt: null,
        leaseToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      }));
    });
  }

  async renew(task: Task): Promise<boolean> {
    if (!task.leaseToken) return false;
    return this.transaction(async manager => {
      const row = await this.lockedTask(manager, task.id);
      if (!this.owns(task, row)) return false;
      await manager.update(Task, { id: task.id }, { leaseExpiresAt: new Date(Date.now() + LEASE_MS) });
      return true;
    });
  }

  private owns(task: Task, row: Task | null): row is Task {
    return !!row && row.status === 'running' && !!task.leaseToken && row.leaseToken === task.leaseToken
      && !!row.leaseExpiresAt && row.leaseExpiresAt.getTime() > Date.now();
  }

  complete(task: Task, issue: (manager: EntityManager) => Promise<IssuedGrant>): Promise<IssuedGrant | null> {
    return this.withUnbannedUser(task.telegramUserId, async manager => {
      const row = await this.lockedTask(manager, task.id);
      if (!this.owns(task, row)) return null;
      const issued = await issue(manager);
      const now = new Date();
      await manager.update(Task, { id: task.id }, { status: 'completed', grantId: issued.grant.id,
        updatedAt: now, finishedAt: now, leaseToken: null, leaseExpiresAt: null });
      return issued;
    });
  }

  private async finishUnsuccessful(manager: EntityManager, row: Task, status: 'cancelled' | 'failed', reason: string | null) {
    if (row.quotaConsumed) {
      await manager.createQueryBuilder().update(TelegramBotDailyUsage)
        .set({ issuedCount: () => '"issuedCount" - 1', updatedAt: new Date() })
        .where({ telegramUserId: row.telegramUserId, usageDate: row.usageDate }).andWhere('"issuedCount" > 0').execute();
    }
    const now = new Date();
    // A cancelled running transfer keeps its slot until the original worker drains or its lease expires.
    if (status === 'failed') { row.leaseToken = null; row.leaseExpiresAt = null; }
    Object.assign(row, { status, finishedAt: now, updatedAt: now, failureReason: reason });
    await manager.save(Task, row);
  }

  fail(task: Task, reason: string): Promise<boolean> {
    return this.withUserLock(task.telegramUserId, async manager => {
      const row = await this.lockedTask(manager, task.id);
      if (!this.owns(task, row)) return false;
      await this.finishUnsuccessful(manager, row, 'failed', reason === 'disk_unavailable' ? reason : 'transfer_failed');
      return true;
    });
  }

  retry(task: Task, delayMs: number): Promise<boolean> {
    if (!task.leaseToken) return Promise.resolve(false);
    return this.transaction(async manager => {
      await this.lock(manager, 'inbound-bot:' + task.receiverBotId);
      const row = await this.lockedTask(manager, task.id);
      if (!this.owns(task, row)) return false;
      const now = new Date();
      const retryAt = new Date(now.getTime() + Math.max(0, delayMs));
      const botCooldownUntil = row.botCooldownUntil && row.botCooldownUntil > retryAt ? row.botCooldownUntil : retryAt;
      await manager.update(Task, { id: task.id }, {
        status: 'queued', availableAt: retryAt, botCooldownUntil, updatedAt: now, leaseToken: null, leaseExpiresAt: null,
      });
      return true;
    });
  }

  release(task: Task): Promise<boolean> {
    if (!task.leaseToken) return Promise.resolve(false);
    return this.transaction(async manager => {
      const row = await this.lockedTask(manager, task.id);
      if (!row || row.leaseToken !== task.leaseToken || (row.status !== 'running' && row.status !== 'cancelled')) return false;
      const status = row.status === 'running' ? 'queued' : 'cancelled';
      await manager.update(Task, { id: task.id }, { status, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() });
      return true;
    });
  }

  async findById(id: string): Promise<Task | null> {
    return this.db.manager.findOneBy(Task, { id });
  }

  async cancelOne(id: string, onCancel?: (manager: EntityManager, task: Task) => Promise<void>) {
    const task = await this.db.manager.findOneBy(Task, { id });
    if (!task) return null;
    return this.withUserLock(task.telegramUserId, async manager => {
      const row = await this.lockedTask(manager, id);
      if (!row) return null;
      const changed = row.status === 'queued' || row.status === 'running';
      if (changed) {
        await this.finishUnsuccessful(manager, row, 'cancelled', null);
        await onCancel?.(manager, row);
      }
      return { task: row, changed };
    });
  }

  /** Caller holds this user's lock; ban, grant revocations and quota refunds commit together. */
  async cancelAllForUser(manager: EntityManager, telegramUserId: string): Promise<number> {
    const tasks = await manager.find(Task, {
      where: { telegramUserId, status: In(['queued', 'running']) }, order: { sequence: 'ASC' },
      ...(this.dialect === 'postgres' ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    for (const task of tasks) await this.finishUnsuccessful(manager, task, 'cancelled', null);
    return tasks.length;
  }

  private async noticeCandidate(manager: EntityManager, receiverBotId: string, now: Date) {
    const ready = '("nextNoticeAt" IS NULL OR "nextNoticeAt" <= $2)';
    const pending = '("noticeStatus" IS NULL OR "noticeStatus" <> "status")';
    // Terminal results take priority. Use a window over just active jobs for live FIFO positions.
    const rows = await databaseRawQuery<Array<{ id: string; status: Task['status']; position: number | string }>>(manager,
      `WITH active AS (
        SELECT "id", "status", "sequence", "nextNoticeAt", "noticeStatus", "noticePosition", ROW_NUMBER() OVER (ORDER BY "sequence") AS rank FROM telegram_bot_inbound_tasks
        WHERE "receiverBotId" = $1 AND "status" IN ('queued','running')
      ), candidates AS (
        SELECT "id", "status", "sequence", 0 AS position, 0 AS priority FROM telegram_bot_inbound_tasks
        WHERE "receiverBotId" = $1 AND "status" IN ('completed','failed','cancelled') AND ${ready} AND ${pending}
        UNION ALL
        SELECT "id", "status", "sequence", CASE WHEN "status" = 'queued' THEN rank ELSE 0 END AS position,
          CASE WHEN "status" = 'running' THEN 1 ELSE 2 END AS priority FROM active WHERE ${ready} AND
          (${pending} OR ("status" = 'queued' AND ("noticePosition" IS NULL OR "noticePosition" <> rank)))
      ) SELECT "id", "status", position FROM candidates ORDER BY priority, "sequence" LIMIT 1`,
      [receiverBotId, now], this.dialect);
    return rows[0] ?? null;
  }

  async nextNotice(receiverBotId: string): Promise<InboundNotice | null> {
    if (!await this.noticeCandidate(this.db.manager, receiverBotId, new Date())) return null;
    return this.transaction(async manager => {
      await this.lock(manager, 'inbound-bot:' + receiverBotId);
      const now = new Date();
      if (await manager.existsBy(Task, [
        { receiverBotId, noticeLeaseUntil: MoreThan(now) }, { receiverBotId, botCooldownUntil: MoreThan(now) },
      ])) return null;
      const next = await this.noticeCandidate(manager, receiverBotId, now);
      if (!next) return null;
      const task = await this.lockedTask(manager, next.id);
      if (!task || task.status !== next.status) return null;
      task.noticeLeaseUntil = new Date(now.getTime() + LEASE_MS);
      await manager.update(Task, { id: task.id }, { noticeLeaseUntil: task.noticeLeaseUntil });
      return { task, position: Number(next.position) };
    });
  }

  async markNotice({ task, position }: InboundNotice, messageId: number | null): Promise<void> {
    if (!task.noticeLeaseUntil) return;
    await this.transaction(manager => manager.update(Task, { id: task.id, noticeLeaseUntil: task.noticeLeaseUntil! }, {
      waitingMsgId: messageId ?? task.waitingMsgId, noticeStatus: task.status, noticePosition: position, nextNoticeAt: null, noticeLeaseUntil: null,
    }));
  }

  async deferNotice({ task }: InboundNotice, delayMs: number, botWide = false): Promise<void> {
    if (!task.noticeLeaseUntil) return;
    await this.transaction(async manager => {
      if (botWide) await this.lock(manager, 'inbound-bot:' + task.receiverBotId);
      const row = await this.lockedTask(manager, task.id);
      if (!row || row.noticeLeaseUntil?.getTime() !== task.noticeLeaseUntil!.getTime()) return;
      const nextNoticeAt = new Date(Date.now() + Math.max(0, delayMs));
      const extendCooldown = botWide && (!row.botCooldownUntil || row.botCooldownUntil < nextNoticeAt);
      await manager.update(Task, { id: task.id },
        { noticeLeaseUntil: null, nextNoticeAt, ...(extendCooldown && { botCooldownUntil: nextNoticeAt }) });
    });
  }
}
