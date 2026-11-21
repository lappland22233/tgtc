import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSource, EntityManager } from 'typeorm';
import type { EnqueueInboundTask, TelegramBotInboundQueueService } from './telegram-bot-inbound-queue.service';
import type { TelegramBotInboundTask } from '../common/entities/telegram-bot-inbound-task.entity';
import type { IssuedGrant } from './telegram-bot-grant.service';

const inputs = (bot: string, user: string, message: string): EnqueueInboundTask => ({
  receiverBotId: bot, sourceAccountId: null, telegramUserId: user, telegramUsername: null,
  telegramDisplayName: null, chatId: user, messageId: message, telegramFileId: 'sample-id-' + bot,
  fileUniqueId: null, fileName: 'sample.txt', mimeType: 'text/plain', fileSize: '8',
  usageDate: '2026-10-11', dailyLimit: 8,
});

const dialects = ['sqlite', ...(process.env.PG_API_KEY_IT === '1' ? ['postgres'] : [])];
describe.each(dialects)('persistent inbound queue on %s', dialect => {
  let db: DataSource;
  let admin: DataSource | undefined;
  let dir: string;
  let queue: TelegramBotInboundQueueService;
  let other: TelegramBotInboundQueueService;
  let Task: typeof TelegramBotInboundTask;
  let Ban: typeof import('../common/entities/telegram-bot-user-ban.entity').TelegramBotUserBan;
  let Usage: typeof import('../common/entities/telegram-bot-daily-usage.entity').TelegramBotDailyUsage;
  let Allow: typeof import('../common/entities/telegram-bot-whitelist.entity').TelegramBotWhitelist;
  const originalType = process.env.DB_TYPE;
  const database = 'tgtc_inbound_' + process.pid + '_' + Date.now();
  beforeAll(async () => {
    process.env.DB_TYPE = dialect;
    jest.resetModules();
    const { DataSource } = jest.requireActual<typeof import('typeorm')>('typeorm');
    const { createDatabaseOptions } = jest.requireActual<typeof import('../database/database.config')>('../database/database.config');
    const { TelegramBotInboundQueueService: Queue } = jest.requireActual<typeof import('./telegram-bot-inbound-queue.service')>('./telegram-bot-inbound-queue.service');
    Task = require('../common/entities/telegram-bot-inbound-task.entity').TelegramBotInboundTask;
    Ban = require('../common/entities/telegram-bot-user-ban.entity').TelegramBotUserBan;
    Usage = require('../common/entities/telegram-bot-daily-usage.entity').TelegramBotDailyUsage;
    Allow = require('../common/entities/telegram-bot-whitelist.entity').TelegramBotWhitelist;
    dir = await mkdtemp(join(tmpdir(), 'tgtc-inbound-queue-'));
    const options = createDatabaseOptions({ ...process.env, DB_TYPE: dialect, DB_MIGRATIONS_RUN: 'false' });
    if (dialect === 'postgres') {
      admin = await new DataSource(options).initialize();
      await admin.query('CREATE DATABASE "' + database + '"');
    }
    db = await new DataSource({ ...options, database: dialect === 'postgres' ? database : join(dir, 'queue.sqlite') } as typeof options).initialize();
    await db.runMigrations();
    queue = new Queue(db);
    other = new Queue(db);
  }, 30000);

  afterAll(async () => {
    await Promise.all([queue?.onApplicationShutdown(), other?.onApplicationShutdown()]);
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query('DROP DATABASE "' + database + '" WITH (FORCE)');
      await admin.destroy();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
    if (originalType === undefined) delete process.env.DB_TYPE;
    else process.env.DB_TYPE = originalType;
  });

  const used = async (telegramUserId: string) => (await db.manager.findOneByOrFail(Usage, { telegramUserId })).issuedCount;
  const claim = async (bot: string) => (await queue.claimNext(bot))!;
  const issue = async (manager: EntityManager, task: TelegramBotInboundTask): Promise<IssuedGrant> => {
    const { TelegramBotFileGrant } = require('../common/entities/telegram-bot-file-grant.entity') as typeof import('../common/entities/telegram-bot-file-grant.entity');
    const token = randomUUID();
    const grant = await manager.save(TelegramBotFileGrant, {
      id: randomUUID(), telegramUserId: task.telegramUserId, chatId: task.chatId, messageId: task.messageId,
      receiverBotId: task.receiverBotId, telegramFileId: task.telegramFileId, tokenHash: token,
      tokenPrefix: 'local', expiresAt: new Date(Date.now() + 1000), createdAt: new Date(),
    });
    return { token, grant };
  };

  if (dialect === 'sqlite') {
    it('upgrades a pre-queue schema in place and preserves the task, ban and older grant on migration replay', async () => {
      const { DataSource } = jest.requireActual<typeof import('typeorm')>('typeorm');
      const { SqliteBotInboundQueue1804700000000 } = require('../migrations/1804700000000-SqliteBotInboundQueue') as typeof import('../migrations/1804700000000-SqliteBotInboundQueue');
      const old = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Task, Ban] }).initialize();
      const runner = old.createQueryRunner();
      const migration = new SqliteBotInboundQueue1804700000000();
      try {
        await runner.query('CREATE TABLE telegram_bot_file_grants (id varchar PRIMARY KEY, "revokedBy" varchar(32))');
        await runner.query("INSERT INTO telegram_bot_file_grants VALUES ('old-id','123456789')");
        await migration.up(runner);
        const { dailyLimit, ...input } = inputs('10', '15', '20');
        const job = await old.manager.save(Task, { ...input, status: 'queued', id: randomUUID(), quotaUsed: dailyLimit,
          quotaConsumed: true, createdAt: new Date(), updatedAt: new Date() });
        await old.manager.save(Ban, { telegramUserId: '17', bannedBy: randomUUID(), reason: 'test', bannedAt: new Date() });
        await migration.down();
        await migration.up(runner);
        expect(job.sequence).toBe(1);
        expect((await old.manager.findOneByOrFail(Task, { id: job.id })).fileSize).toBe('8');
        expect(await old.manager.count(Ban)).toBe(1);
        expect(await runner.query('SELECT "revokedBy" FROM telegram_bot_file_grants')).toEqual([{ revokedBy: '123456789' }]);
      } finally {
        await runner.release();
        await old.destroy();
      }
    });
  }

  it('atomically deduplicates delivery, charges once, enforces the limit and respects the whitelist', async () => {
    const input = { ...inputs('101', '21', '1'), dailyLimit: 1 };
    const deliveries = await Promise.all([queue.enqueue(input), other.enqueue(input)]);
    expect(deliveries.map(reply => reply.status).sort()).toEqual(['duplicate', 'queued']);
    expect(await used('21')).toBe(1);
    expect(await queue.enqueue({ ...input, receiverBotId: '102' })).toEqual({ status: 'quota_denied', used: 1 });
    await db.manager.save(Allow, { id: randomUUID(), telegramUserId: '21', enabled: true, source: 'admin', createdAt: new Date() });
    expect(await queue.enqueue({ ...input, receiverBotId: '102' })).toMatchObject({
      status: 'queued', task: { receiverBotId: '102', quotaConsumed: false }, used: 1,
    });
    expect((await other.findByMessage('101', '21', '1'))?.fileSize).toBe('8');
    expect(await used('21')).toBe(1);
  });

  it('keeps the delayed FIFO head, isolates Bots, and fences lease takeover after a worker restart', async () => {
    await queue.enqueue(inputs('201', '31', '1'));
    await queue.enqueue(inputs('201', '32', '2'));
    await queue.enqueue(inputs('202', '31', '1'));
    const claims = await Promise.all([queue.claimNext('201'), other.claimNext('201')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(Boolean)!;
    expect(first.messageId).toBe('1');
    expect((await claim('202')).receiverBotId).toBe('202');
    expect(await queue.renew(first)).toBe(true);
    expect(await queue.retry(first, 60000)).toBe(true);
    expect(await other.claimNext('201')).toBeNull();
    await db.manager.update(Task, { id: first.id }, { availableAt: new Date(0), botCooldownUntil: new Date(0) });
    const secondAttempt = await claim('201');
    await db.manager.update(Task, { id: first.id }, { leaseExpiresAt: new Date(0) });
    const recovered = (await other.claimNext('201'))!;
    expect(recovered.id).toBe(first.id);
    expect(recovered.leaseToken).not.toBe(secondAttempt.leaseToken);
    const staleIssue = jest.fn();
    expect(await queue.complete(secondAttempt, staleIssue)).toBeNull();
    expect(staleIssue).not.toHaveBeenCalled();
    expect(await queue.renew(secondAttempt)).toBe(false);
    expect(await queue.release(secondAttempt)).toBe(false);
    expect(await queue.fail(secondAttempt, 'transfer_failed')).toBe(false);
    const issued = await other.complete(recovered, manager => issue(manager, recovered));
    expect(issued?.grant.id).toBeTruthy();
    expect((await queue.findByMessage('201', '31', '1'))?.grantId).toBe(issued?.grant.id);
    expect((await claim('201')).messageId).toBe('2');
  });

  it('cancels and refunds atomically, rolls back audit failures and waits for the old stream to drain', async () => {
    await queue.enqueue(inputs('301', '41', '1'));
    await queue.enqueue(inputs('301', '42', '2'));
    const current = await claim('301');
    await expect(other.cancelOne(current.id, async () => { throw new Error('audit unavailable'); })).rejects.toThrow('audit unavailable');
    expect(await queue.renew(current)).toBe(true);
    expect(await used('41')).toBe(1);
    expect(await other.cancelOne(current.id)).toMatchObject({ changed: true, task: { status: 'cancelled' } });
    expect(await queue.cancelOne(current.id)).toMatchObject({ changed: false });
    expect(await used('41')).toBe(0);
    expect(await queue.renew(current)).toBe(false);
    expect(await queue.complete(current, jest.fn())).toBeNull();
    expect(await queue.claimNext('301')).toBeNull();
    expect(await queue.release(current)).toBe(true);
    const next = await claim('301');
    expect(next.telegramUserId).toBe('42');
    expect(await queue.fail(next, 'raw upstream message')).toBe(true);
    expect(await queue.fail(next, 'raw upstream message')).toBe(false);
    expect((await queue.findByMessage('301', '42', '2'))?.failureReason).toBe('transfer_failed');
    expect(await used('42')).toBe(0);
  });

  it('denies new and in-flight grants after a ban across receiving Bots', async () => {
    await queue.enqueue(inputs('401', '51', '1'));
    await queue.enqueue(inputs('402', '51', '2'));
    const first = await claim('401');
    await other.withUserLock('51', async manager => {
      await manager.save(Ban, { telegramUserId: '51', bannedBy: randomUUID(), reason: 'fixture', bannedAt: new Date() });
      expect(await other.cancelAllForUser(manager, '51')).toBe(2);
    });
    expect(await queue.isBanned('51')).toBe(true);
    expect(await queue.complete(first, jest.fn())).toBeNull();
    expect(await queue.withUnbannedUser('51', jest.fn())).toBeNull();
    expect(await queue.enqueue(inputs('403', '51', '3'))).toEqual({ status: 'banned', used: 0 });
    expect(await queue.claimNext('402')).toBeNull();
    expect(await used('51')).toBe(0);
  });

  it('preserves a Bot-wide Telegram rate limit across workers even if its originating task is removed', async () => {
    await queue.enqueue(inputs('601', '81', '1'));
    await queue.enqueue(inputs('601', '82', '2'));
    await queue.enqueue(inputs('602', '83', '1'));
    const running = await claim('601');
    const notice = (await queue.nextNotice('601'))!;
    await queue.deferNotice(notice, 60000, true);
    const until = (await db.manager.findOneByOrFail(Task, { id: running.id })).botCooldownUntil;
    expect(await other.retry(running, 1000)).toBe(true);
    expect((await db.manager.findOneByOrFail(Task, { id: running.id })).botCooldownUntil).toEqual(until);
    await other.cancelOne(notice.task.id);
    expect(await other.nextNotice('601')).toBeNull();
    expect(await other.claimNext('601')).toBeNull();
    expect((await other.claimNext('602'))?.telegramUserId).toBe('83');
    await db.manager.update(Task, { id: notice.task.id }, { botCooldownUntil: new Date(0) });
    expect((await other.claimNext('601'))?.telegramUserId).toBe('82');
  });

  it('edits durable notice positions, serializes senders and prioritizes completed states', async () => {
    await queue.enqueue(inputs('501', '61', '1'));
    await queue.enqueue(inputs('501', '62', '2'));
    const notices = await Promise.all([queue.nextNotice('501'), other.nextNotice('501')]);
    expect(notices.filter(Boolean)).toHaveLength(1);
    const first = notices.find(Boolean)!;
    expect(first.position).toBe(1);
    await queue.markNotice(first, 71);
    const second = (await other.nextNotice('501'))!;
    expect(second.position).toBe(2);
    await queue.markNotice(second, 72);
    expect(await queue.nextNotice('501')).toBeNull();
    const active = await claim('501');
    const running = (await other.nextNotice('501'))!;
    expect(running).toMatchObject({ position: 0, task: { waitingMsgId: 71, status: 'running' } });
    await other.deferNotice(running, 60000);
    expect(await queue.nextNotice('501')).toBeNull();
    await db.manager.update(Task, { id: first.task.id }, { nextNoticeAt: new Date(0) });
    await queue.complete(active, manager => issue(manager, active));
    const finished = (await other.nextNotice('501'))!;
    expect(finished.task).toMatchObject({ status: 'completed', waitingMsgId: 71 });
    await other.markNotice(finished, 71);
    const shifted = (await other.nextNotice('501'))!;
    expect(shifted).toMatchObject({ position: 1, task: { waitingMsgId: 72, status: 'queued' } });
    await other.markNotice(shifted, null);
    expect(await queue.nextNotice('501')).toBeNull();
  });
});
