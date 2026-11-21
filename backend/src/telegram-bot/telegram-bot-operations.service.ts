import { BadRequestException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { DataSource, EntityManager, IsNull, MoreThan, Raw } from 'typeorm';
import { AccessLog } from '../common/entities/access-log.entity';
import { AuditAction, AuditLog } from '../common/entities/audit-log.entity';
import { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';
import { type InboundTaskStatus, TelegramBotInboundTask } from '../common/entities/telegram-bot-inbound-task.entity';
import { TelegramBotUserBan } from '../common/entities/telegram-bot-user-ban.entity';
import { TelegramBotConfigService } from './telegram-bot-config.service';
import { TelegramBotGrantService } from './telegram-bot-grant.service';
import { TelegramBotInboundQueueService } from './telegram-bot-inbound-queue.service';
import { BotGrantsQuery, BotOperationsPage, BotOperationsTimePage, BotQueueQuery } from './telegram-bot-operations.dto';
import { TelegramBotQuotaService } from './telegram-bot-quota.service';

const queueFields = [
  'id', 'receiverBotId', 'telegramUserId', 'telegramUsername', 'telegramDisplayName', 'fileName', 'fileSize',
  'status', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'grantId', 'failureReason',
] as const satisfies readonly (keyof TelegramBotInboundTask)[];
const grantFields = [
  'id', 'receiverBotId', 'sourceAccountId', 'telegramUserId', 'telegramUsername', 'telegramDisplayName',
  'fileName', 'fileSize', 'storageBackend', 'createdAt', 'expiresAt', 'revokedAt', 'revokedBy', 'accessCount', 'tokenPrefix',
] as const satisfies readonly (keyof TelegramBotFileGrant)[];
const auditActions = [
  'telegram_bot_task_cancelled', 'telegram_bot_user_banned', 'telegram_bot_link_revoked',
  'telegram_bot_link_queried', 'telegram_bot_whitelist_add', 'telegram_bot_whitelist_remove',
] as const satisfies readonly AuditAction[];
const auditDetailFields = [
  'targetTelegramUserId', 'grantId', 'taskId', 'receiverBotId', 'reason', 'cancelledTasks',
  'revokedGrants', 'alreadyBanned', 'replayable', 'operatorTelegramUserId', 'tokenPrefix',
];

function dateFilter(query: BotOperationsTimePage, db: DataSource) {
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;
  if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime()))) {
    throw new BadRequestException('时间格式无效');
  }
  if (from && to && from > to) throw new BadRequestException('开始时间不能晚于结束时间');
  if (!from && !to) return {};
  // SQLite's CURRENT_TIMESTAMP has no fractional part. Include old rows stored as HH:mm:ss
  // at an exact lower boundary, while preserving the index on the unmodified column.
  const lower = from && db.options.type === 'better-sqlite3'
    ? from.toISOString().replace('T', ' ').replace(/(\.000)?Z$/, '') : from;
  return { createdAt: Raw<Date>(column => [
    from && column + ' >= :createdFrom', to && column + ' <= :createdTo',
  ].filter(Boolean).join(' AND '), { createdFrom: lower, createdTo: to }) };
}

function filters(query: BotQueueQuery | BotGrantsQuery, db: DataSource) {
  return {
    ...dateFilter(query, db),
    ...(query.telegramUserId && { telegramUserId: query.telegramUserId }),
    ...(query.receiverBotId && { receiverBotId: query.receiverBotId }),
  };
}

function pageOptions({ page, pageSize }: BotOperationsPage) {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

function activeGrant(now: Date) {
  return { revokedAt: IsNull(), expiresAt: MoreThan(now) };
}

function pick<T, K extends keyof T>(row: T, fields: readonly K[]): Pick<T, K> {
  return Object.fromEntries(fields.map((key) => [key, row[key]])) as Pick<T, K>;
}

/** 管理处置的状态与审计共用事务。一条失败的审计不会留下未记录的撤销或封禁。 */
async function record(
  manager: EntityManager, action: AuditAction, operator: string, resourceType: string, resourceId: string,
  telegramUserId: string, metadata: Record<string, unknown> = {},
) {
  const logs = manager.getRepository(AuditLog);
  await logs.save(logs.create({
    action, userId: operator, resourceType, resourceId, metadata: { targetTelegramUserId: telegramUserId, ...metadata },
  }));
}

@Injectable()
export class TelegramBotOperationsService {
  constructor(
    private readonly db: DataSource,
    private readonly queue: TelegramBotInboundQueueService,
    private readonly grants: TelegramBotGrantService,
    private readonly config: TelegramBotConfigService,
    private readonly quota: TelegramBotQuotaService,
  ) {}

  async listQueue(query: BotQueueQuery) {
    const where = { ...filters(query, this.db), ...(query.status !== 'all' && { status: query.status }) };
    const builder = this.db.getRepository(TelegramBotInboundTask).createQueryBuilder('task')
      .setFindOptions({ where, ...pageOptions(query) })
      .select(queueFields.map((key) => 'task.' + key))
      .orderBy('task.sequence', query.status === 'queued' || query.status === 'running' ? 'ASC' : 'DESC');
    // Rank against the whole receiving bot, even on filtered pages or when viewing one user's history.
    builder.addSelect(sub => sub.select('COUNT(*)').from(TelegramBotInboundTask, 'other')
      .where('other.receiverBotId = task.receiverBotId')
      .andWhere('other.sequence <= task.sequence')
      .andWhere('other.status IN (:...unfinished) AND task.status IN (:...unfinished)'), 'queue_position')
      .setParameter('unfinished', ['queued', 'running']);
    const [{ entities, raw }, total] = await Promise.all([builder.getRawAndEntities(), builder.clone().getCount()]);
    const rows = entities.map((task, i) => ({
      ...pick(task, queueFields),
      position: ['queued', 'running'].includes(task.status) ? Number(raw[i].queue_position) : null,
    }));
    return { rows, total, page: query.page, pageSize: query.pageSize };
  }

  async listGrants(query: BotGrantsQuery) {
    const now = new Date();
    const builder = this.db.getRepository(TelegramBotFileGrant).createQueryBuilder('grant')
      .setFindOptions({ where: filters(query, this.db), ...pageOptions(query) })
      .select(grantFields.map((key) => 'grant.' + key))
      .orderBy('grant.createdAt', 'DESC').addOrderBy('grant.id', 'DESC');
    if (query.status === 'revoked') builder.andWhere('grant.revokedAt IS NOT NULL');
    if (query.status === 'active' || query.status === 'expired') {
      builder.andWhere('grant.revokedAt IS NULL')
        .andWhere(query.status === 'active' ? 'grant.expiresAt > :now' : 'grant.expiresAt <= :now', { now });
    }
    const [grants, total] = await builder.getManyAndCount();
    const rows = grants.map(grant => ({
      ...pick(grant, grantFields), fileSize: grant.fileSize == null ? null : String(grant.fileSize),
      status: grant.revokedAt ? 'revoked' : grant.expiresAt > now ? 'active' : 'expired',
    }));
    return { rows, total, page: query.page, pageSize: query.pageSize };
  }

  async cancel(id: string, operator: string) {
    const result = await this.queue.cancelOne(id, (manager, task) =>
      record(manager, 'telegram_bot_task_cancelled', operator, 'telegram_bot_task', id, task.telegramUserId,
        { taskId: id, receiverBotId: task.receiverBotId }));
    if (!result) throw new NotFoundException('上传任务不存在');
    return { changed: result.changed };
  }

  private async grantOwner(id: string) {
    const grant = await this.db.getRepository(TelegramBotFileGrant).findOne({
      where: { id }, select: { telegramUserId: true },
    });
    if (!grant) throw new NotFoundException('直链记录不存在');
    return grant.telegramUserId;
  }

  async revoke(id: string, operator: string) {
    const telegramUserId = await this.grantOwner(id);
    return this.queue.withUserLock(telegramUserId, async manager => {
      const now = new Date();
      const revoked = await manager.update(TelegramBotFileGrant, { id, telegramUserId, ...activeGrant(now) },
        { revokedAt: now, revokedBy: operator });
      const changed = Boolean(revoked.affected);
      if (changed) await record(manager, 'telegram_bot_link_revoked', operator, 'telegram_bot_grant', id, telegramUserId, { grantId: id });
      return { changed };
    });
  }

  async reveal(id: string, operator: string, request: Request) {
    const telegramUserId = await this.grantOwner(id);
    const origin = await this.config.resolveSiteOriginAsync(request);
    return this.queue.withUserLock(telegramUserId, async manager => {
      const grant = await manager.findOneBy(TelegramBotFileGrant, { id, telegramUserId });
      if (!grant) throw new NotFoundException('直链记录不存在');
      if (!this.grants.isActive(grant)) throw new GoneException('直链已撤销或过期');
      const token = this.grants.replayToken(grant);
      const url = token && origin ? this.grants.buildUrl(origin, token) : null;
      await record(manager, 'telegram_bot_link_queried', operator, 'telegram_bot_grant', id, telegramUserId,
        { grantId: id, replayable: Boolean(url) });
      return { url };
    });
  }

  async ban(telegramUserId: string, reason: string, operator: string) {
    return this.queue.withUserLock(telegramUserId, async manager => {
      const bans = manager.getRepository(TelegramBotUserBan);
      const existing = await bans.findOneBy({ telegramUserId });
      const ban = existing ?? await bans.save(bans.create({ telegramUserId, reason, bannedBy: operator }));
      const cancelledTasks = await this.queue.cancelAllForUser(manager, telegramUserId);
      const now = new Date();
      const revoked = await manager.update(TelegramBotFileGrant, { telegramUserId, ...activeGrant(now) },
        { revokedAt: now, revokedBy: operator });
      const revokedGrants = revoked.affected ?? 0;
      if (!existing || cancelledTasks || revokedGrants) {
        await record(manager, 'telegram_bot_user_banned', operator, 'telegram_bot_user', telegramUserId, telegramUserId,
          { reason: ban.reason, cancelledTasks, revokedGrants, alreadyBanned: Boolean(existing) });
      }
      return { ban, cancelledTasks, revokedGrants };
    });
  }

  async userDetails(telegramUserId: string) {
    const config = await this.config.getConfig();
    const usageDate = this.quota.getBusinessDate(config.quotaTimezone);
    const grantRepo = this.db.getRepository(TelegramBotFileGrant);
    const [ban, uploadCounts, issued, active, transfers, used, whitelisted] = await Promise.all([
      this.db.getRepository(TelegramBotUserBan).findOneBy({ telegramUserId }),
      this.db.getRepository(TelegramBotInboundTask).createQueryBuilder('task')
        .select('task.status', 'status').addSelect('COUNT(*)', 'count')
        .where('task.telegramUserId = :telegramUserId', { telegramUserId }).groupBy('task.status')
        .getRawMany<{ status: InboundTaskStatus; count: string | number }>(),
      grantRepo.countBy({ telegramUserId }), grantRepo.countBy({ telegramUserId, ...activeGrant(new Date()) }),
      this.db.getRepository(AccessLog).createQueryBuilder('log')
        .select('COUNT(*)', 'requests')
        .addSelect('CAST(COALESCE(SUM(COALESCE(log.responseBodyBytes, log.responseSize)), 0) AS TEXT)', 'bytes')
        .where('log.botTelegramUserId = :telegramUserId AND log.botGrantId IS NOT NULL', { telegramUserId })
        .getRawOne<{ requests: string | number; bytes: string }>(),
      this.quota.getUsed(telegramUserId, usageDate), this.quota.isWhitelisted(telegramUserId),
    ]);
    const byStatus: Record<InboundTaskStatus, number> = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const row of uploadCounts) byStatus[row.status] = Number(row.count);
    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    return {
      telegramUserId, ban, uploads: { total, byStatus }, grants: { total: issued, active },
      downloads: { requests: Number(transfers?.requests ?? 0), bytes: transfers?.bytes ?? '0' },
      quota: { used, limit: whitelisted ? null : config.dailyLimit,
        remaining: whitelisted ? null : Math.max(0, config.dailyLimit - used), usageDate, whitelisted },
    };
  }

  async userAudit(telegramUserId: string, page: BotOperationsTimePage) {
    const user = this.db.options.type === 'postgres'
      ? "log.metadata ->> 'targetTelegramUserId'" : "json_extract(log.metadata, '$.targetTelegramUserId')";
    const [logs, total] = await this.db.getRepository(AuditLog).createQueryBuilder('log')
      .setFindOptions({ where: dateFilter(page, this.db), ...pageOptions(page) })
      .andWhere('log.action IN (:...actions)', { actions: auditActions })
      .andWhere(user + ' = :telegramUserId', { telegramUserId })
      .orderBy('log.createdAt', 'DESC').addOrderBy('log.id', 'DESC')
      .getManyAndCount();
    const rows = logs.map(log => ({
      id: log.id, action: log.action, userId: log.userId, resourceType: log.resourceType,
      resourceId: log.resourceId, createdAt: log.createdAt, status: log.status,
      metadata: Object.fromEntries(Object.entries(log.metadata ?? {}).filter(([key]) => auditDetailFields.includes(key))),
    }));
    return { rows, total, page: page.page, pageSize: page.pageSize };
  }
}
