import { BadRequestException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { DataSource, EntityManager, IsNull, MoreThan, Raw } from 'typeorm';
import { AccessLog } from '../common/entities/access-log.entity';
import { AuditAction, AuditLog } from '../common/entities/audit-log.entity';
import { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';
import { type InboundTaskStatus, TelegramBotInboundTask } from '../common/entities/telegram-bot-inbound-task.entity';
import { TelegramBotUserBan } from '../common/entities/telegram-bot-user-ban.entity';
import { databaseCast, databaseDateBucket, databaseRawQuery } from '../database/database-types';
import { TelegramBotConfigService } from './telegram-bot-config.service';
import { TelegramBotGrantService } from './telegram-bot-grant.service';
import { TelegramBotInboundQueueService } from './telegram-bot-inbound-queue.service';
import {
  BotGrantsQuery, BotOperationsPage, BotOperationsTimePage, BotOverviewQuery, BotQueueQuery,
  BotUserGroupsQuery, type BotUserGroupScope,
} from './telegram-bot-operations.dto';
import { TelegramBotQuotaService } from './telegram-bot-quota.service';

const overviewRanges = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
} as const;

export interface OverviewTrendRow {
  bucket: string;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
}

export interface BotUserGroupRow {
  telegramUserId: string;
  telegramUsername: string | null;
  total: number;
  byStatus: Record<string, number>;
  bytes: string;
  downloads: number;
  lastAt: string | null;
}

export interface BotUserGroupPage {
  scope: BotUserGroupScope;
  page: number;
  pageSize: number;
  total: number;
  rows: BotUserGroupRow[];
}

const queueFields = [
  'id', 'receiverBotId', 'telegramUserId', 'telegramUsername', 'telegramDisplayName', 'fileName', 'fileSize',
  'status', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'grantId', 'failureReason',
] as const satisfies readonly (keyof TelegramBotInboundTask)[];
const grantFields = [
  'id', 'receiverBotId', 'sourceAccountId', 'telegramUserId', 'telegramUsername', 'telegramDisplayName',
  'fileName', 'fileSize', 'storageBackend', 'createdAt', 'expiresAt', 'revokedAt', 'revokedBy', 'accessCount', 'tokenPrefix',
  'gdriveCacheStatus', 'gdriveCacheAttempts', 'gdriveCacheLastError',
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

/**
 * SQLite 的 datetime 字符串不带时区（实际按 UTC 存储），直接返回给前端会被
 * `new Date()` 当作浏览器本地时间。统一输出带 Z 的 ISO，与 PostgreSQL 分支一致。
 */
function isoTimestamp(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  if (!text) return null;
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text);
  const parsed = new Date(hasZone ? text : text.replace(' ', 'T') + 'Z');
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
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

  /**
   * 按 TG 用户分类：收件任务 / 直链 / 管理审计三种口径共用一套分页结构。
   *
   * - 只返回聚合结果，明细仍由 `listQueue/listGrants/userAudit` 在进入用户详情后提供；
   * - 用户名取该用户最近一次非空快照（审核只存用户 ID，用户名从收件任务快照回填）；
   * - 关键字同时匹配用户 ID 与用户名（审计口径只能匹配用户 ID）。
   */
  async userGroups(query: BotUserGroupsQuery): Promise<BotUserGroupPage> {
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime())) || (from && to && from > to)) {
      throw new BadRequestException('时间格式无效或开始时间不能晚于结束时间');
    }
    // 展示与搜索提示使用 @username，但快照里存的是不带 @ 的用户名。
    const keyword = (query.keyword ?? '').trim().toLowerCase().replace(/^@/, '');
    const like = keyword ? `%${keyword.replace(/[\\%_]/g, char => '\\' + char)}%` : null;
    const { page, pageSize } = query;
    const offset = (page - 1) * pageSize;

    if (query.scope === 'queue') {
      const listParams: unknown[] = [];
      const where = this.userGroupWhere('t', listParams, { from, to, receiverBotId: query.receiverBotId, like });
      const rows = await databaseRawQuery(this.db,
        `SELECT t."telegramUserId" AS "telegramUserId",
                COUNT(*) AS "total",
                COALESCE(SUM(CASE WHEN t."status" = 'queued' THEN 1 ELSE 0 END), 0) AS "queued",
                COALESCE(SUM(CASE WHEN t."status" = 'running' THEN 1 ELSE 0 END), 0) AS "running",
                COALESCE(SUM(CASE WHEN t."status" = 'completed' THEN 1 ELSE 0 END), 0) AS "completed",
                COALESCE(SUM(CASE WHEN t."status" = 'failed' THEN 1 ELSE 0 END), 0) AS "failed",
                COALESCE(SUM(CASE WHEN t."status" = 'cancelled' THEN 1 ELSE 0 END), 0) AS "cancelled",
                ${databaseCast('COALESCE(SUM(t."fileSize"), 0)', 'bigint')} AS "bytes",
                MAX(t."createdAt") AS "lastAt",
                (SELECT latest."telegramUsername"
                   FROM "telegram_bot_inbound_tasks" latest
                  WHERE latest."telegramUserId" = t."telegramUserId"
                    AND latest."telegramUsername" IS NOT NULL
                  ORDER BY latest."createdAt" DESC
                  LIMIT 1) AS "telegramUsername"
           FROM "telegram_bot_inbound_tasks" t
          WHERE ${where}
          GROUP BY t."telegramUserId"
          ORDER BY MAX(t."createdAt") DESC, t."telegramUserId" ASC
          LIMIT $${listParams.length + 1} OFFSET $${listParams.length + 2}`,
        [...listParams, pageSize, offset],
      );
      const countParams: unknown[] = [];
      const countWhere = this.userGroupWhere('t', countParams, { from, to, receiverBotId: query.receiverBotId, like });
      const counts = await databaseRawQuery(this.db,
        `SELECT COUNT(DISTINCT t."telegramUserId") AS "total"
           FROM "telegram_bot_inbound_tasks" t
          WHERE ${countWhere}`,
        countParams,
      );
      return this.mapUserGroups('queue', rows, counts, page, pageSize);
    }

    if (query.scope === 'grants') {
      const listParams: unknown[] = [new Date()];
      const where = this.userGroupWhere('g', listParams, { from, to, receiverBotId: query.receiverBotId, like });
      const rows = await databaseRawQuery(this.db,
        `SELECT g."telegramUserId" AS "telegramUserId",
                COUNT(*) AS "total",
                COALESCE(SUM(CASE WHEN g."revokedAt" IS NOT NULL THEN 1 ELSE 0 END), 0) AS "revoked",
                COALESCE(SUM(CASE WHEN g."revokedAt" IS NULL AND g."expiresAt" > $1 THEN 1 ELSE 0 END), 0) AS "active",
                COALESCE(SUM(CASE WHEN g."revokedAt" IS NULL AND g."expiresAt" <= $1 THEN 1 ELSE 0 END), 0) AS "expired",
                ${databaseCast('COALESCE(SUM(g."accessCount"), 0)', 'bigint')} AS "downloads",
                ${databaseCast('COALESCE(SUM(g."fileSize"), 0)', 'bigint')} AS "bytes",
                MAX(g."createdAt") AS "lastAt",
                (SELECT latest."telegramUsername"
                   FROM "telegram_bot_file_grants" latest
                  WHERE latest."telegramUserId" = g."telegramUserId"
                    AND latest."telegramUsername" IS NOT NULL
                  ORDER BY latest."createdAt" DESC
                  LIMIT 1) AS "telegramUsername"
           FROM "telegram_bot_file_grants" g
          WHERE ${where}
          GROUP BY g."telegramUserId"
          ORDER BY MAX(g."createdAt") DESC, g."telegramUserId" ASC
          LIMIT $${listParams.length + 1} OFFSET $${listParams.length + 2}`,
        [...listParams, pageSize, offset],
      );
      const countParams: unknown[] = [];
      const countWhere = this.userGroupWhere('g', countParams, { from, to, receiverBotId: query.receiverBotId, like });
      const counts = await databaseRawQuery(this.db,
        `SELECT COUNT(DISTINCT g."telegramUserId") AS "total"
           FROM "telegram_bot_file_grants" g
          WHERE ${countWhere}`,
        countParams,
      );
      return this.mapUserGroups('grants', rows, counts, page, pageSize);
    }

    const userExpr = (alias: string) => this.db.options.type === 'postgres'
      ? `${alias}."metadata" ->> 'targetTelegramUserId'`
      : `json_extract(${alias}."metadata", '$.targetTelegramUserId')`;
    const auditWhere = (params: unknown[]) => {
      const conditions = [`${userExpr('al')} IS NOT NULL`];
      const bind = (value: unknown) => { params.push(value); return '$' + params.length; };
      conditions.push(`al."action" IN (${auditActions.map(action => bind(action)).join(', ')})`);
      if (from) conditions.push(`al."createdAt" >= ${bind(from)}`);
      if (to) conditions.push(`al."createdAt" <= ${bind(to)}`);
      if (like) conditions.push(`CAST(${userExpr('al')} AS TEXT) LIKE ${bind(like)} ESCAPE '\\'`);
      return conditions.join(' AND ');
    };
    const listParams: unknown[] = [];
    const where = auditWhere(listParams);
    // 先分页聚合，再在外层回填用户名：避免 PostgreSQL 要求
    // 被关联的 JSON 表达式同时出现在 GROUP BY 中的限制。
    const rows = await databaseRawQuery(this.db,
      `SELECT grouped."telegramUserId" AS "telegramUserId",
              grouped."total" AS "total",
              grouped."lastAt" AS "lastAt",
              (SELECT latest."telegramUsername"
                 FROM "telegram_bot_inbound_tasks" latest
                WHERE latest."telegramUserId" = grouped."telegramUserId"
                  AND latest."telegramUsername" IS NOT NULL
                ORDER BY latest."createdAt" DESC
                LIMIT 1) AS "telegramUsername"
         FROM (SELECT ${userExpr('al')} AS "telegramUserId",
                      COUNT(*) AS "total",
                      MAX(al."createdAt") AS "lastAt"
                 FROM "audit_logs" al
                WHERE ${where}
                GROUP BY ${userExpr('al')}
                ORDER BY MAX(al."createdAt") DESC
                LIMIT $${listParams.length + 1} OFFSET $${listParams.length + 2}) grouped
        ORDER BY grouped."lastAt" DESC`,
      [...listParams, pageSize, offset],
    );
    const countParams: unknown[] = [];
    const countWhere = auditWhere(countParams);
    const counts = await databaseRawQuery(this.db,
      `SELECT COUNT(DISTINCT ${userExpr('al')}) AS "total"
         FROM "audit_logs" al
        WHERE ${countWhere}`,
      countParams,
    );
    return this.mapUserGroups('audit', rows, counts, page, pageSize);
  }

  /** 收件/直链用户分类的公共筛选条件（时间、Bot、用户 ID 或用户名关键字）。 */
  private userGroupWhere(
    alias: string,
    params: unknown[],
    filters: { from: Date | null; to: Date | null; receiverBotId?: string; like: string | null },
  ): string {
    const conditions: string[] = [];
    const bind = (value: unknown) => { params.push(value); return '$' + params.length; };
    if (filters.from) conditions.push(`${alias}."createdAt" >= ${bind(filters.from)}`);
    if (filters.to) conditions.push(`${alias}."createdAt" <= ${bind(filters.to)}`);
    if (filters.receiverBotId) conditions.push(`${alias}."receiverBotId" = ${bind(filters.receiverBotId)}`);
    if (filters.like) {
      conditions.push(
        `(${alias}."telegramUserId" LIKE ${bind(filters.like)} ESCAPE '\\'`
        + ` OR LOWER(${alias}."telegramUsername") LIKE ${bind(filters.like)} ESCAPE '\\')`,
      );
    }
    return conditions.length > 0 ? conditions.join(' AND ') : '1=1';
  }

  private mapUserGroups(
    scope: BotUserGroupScope, rows: unknown, countRows: unknown, page: number, pageSize: number,
  ): BotUserGroupPage {
    const list = Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
    const countRow = Array.isArray(countRows) && countRows.length > 0 ? countRows[0] as Record<string, unknown> : {};
    return {
      scope, page, pageSize,
      total: Number(countRow.total ?? 0),
      rows: list.map(row => {
        const byStatus: Record<string, number> = scope === 'queue'
          ? {
              queued: Number(row.queued ?? 0),
              running: Number(row.running ?? 0),
              completed: Number(row.completed ?? 0),
              failed: Number(row.failed ?? 0),
              cancelled: Number(row.cancelled ?? 0),
            }
          : scope === 'grants'
            ? {
                active: Number(row.active ?? 0),
                expired: Number(row.expired ?? 0),
                revoked: Number(row.revoked ?? 0),
              }
            : {};
        return {
          telegramUserId: String(row.telegramUserId),
          telegramUsername: row.telegramUsername ? String(row.telegramUsername) : null,
          total: Number(row.total ?? 0),
          byStatus,
          bytes: String(row.bytes ?? '0'),
          downloads: Number(row.downloads ?? 0),
          lastAt: isoTimestamp(row.lastAt as string | Date | null | undefined),
        };
      }),
    };
  }

  /**
   * 概览聚合（管理台图表数据）。
   *
   * - 全部聚合在 SQL 侧完成，不把明细行拉进内存；
   * - 「范围内」统计按 createdAt 过滤；`queue.pending/running` 与 `grants.activeNow`
   *   是实时快照，不受时间范围影响（与列表页的操作语义一致）；
   * - 时间桶粒度与 Bot 使用分析保持一致：24h/7d 按小时、30d 按天。
   */
  async overview(query: BotOverviewQuery) {
    const timeRange = query.timeRange;
    const since = new Date(Date.now() - overviewRanges[timeRange]);
    const now = new Date();
    const bucketUnit = timeRange === '30d' ? 'day' : 'hour';
    const bucket = databaseDateBucket('"createdAt"', bucketUnit);
    const grantStatus = `CASE WHEN "revokedAt" IS NOT NULL THEN 'revoked' WHEN "expiresAt" > $2 THEN 'active' ELSE 'expired' END`;
    const [taskRows, snapshotRows, trendRows, grantRows, activeRows, botRows] = await Promise.all([
      databaseRawQuery<{ status: InboundTaskStatus; count: string | number; bytes: string | number | null }[]>(this.db,
        `SELECT "status" AS "status", COUNT(*) AS "count",
                ${databaseCast('COALESCE(SUM("fileSize"), 0)', 'bigint')} AS "bytes"
           FROM "telegram_bot_inbound_tasks"
          WHERE "createdAt" >= $1
          GROUP BY "status"`, [since]),
      databaseRawQuery<{ status: InboundTaskStatus; count: string | number }[]>(this.db,
        `SELECT "status" AS "status", COUNT(*) AS "count"
           FROM "telegram_bot_inbound_tasks"
          WHERE "status" IN ('queued', 'running')
          GROUP BY "status"`, []),
      databaseRawQuery<{ bucket: string | Date; status: InboundTaskStatus; count: string | number }[]>(this.db,
        `SELECT ${bucket} AS "bucket", "status" AS "status", COUNT(*) AS "count"
           FROM "telegram_bot_inbound_tasks"
          WHERE "createdAt" >= $1
          GROUP BY ${bucket}, "status"
          ORDER BY ${bucket} ASC`, [since]),
      databaseRawQuery<{ status: 'active' | 'expired' | 'revoked'; count: string | number; downloads: string | number | null }[]>(this.db,
        `SELECT ${grantStatus} AS "status", COUNT(*) AS "count",
                ${databaseCast('COALESCE(SUM("accessCount"), 0)', 'bigint')} AS "downloads"
           FROM "telegram_bot_file_grants"
          WHERE "createdAt" >= $1
          GROUP BY ${grantStatus}`, [since, now]),
      databaseRawQuery<{ count: string | number }[]>(this.db,
        `SELECT COUNT(*) AS "count"
           FROM "telegram_bot_file_grants"
          WHERE "revokedAt" IS NULL AND "expiresAt" > $1`, [now]),
      databaseRawQuery<{ receiverBotId: string; total: string | number; failed: string | number; bytes: string | number | null }[]>(this.db,
        `SELECT "receiverBotId" AS "receiverBotId", COUNT(*) AS "total",
                COALESCE(SUM(CASE WHEN "status" = 'failed' THEN 1 ELSE 0 END), 0) AS "failed",
                ${databaseCast('COALESCE(SUM("fileSize"), 0)', 'bigint')} AS "bytes"
           FROM "telegram_bot_inbound_tasks"
          WHERE "createdAt" >= $1 AND "receiverBotId" IS NOT NULL
          GROUP BY "receiverBotId"
          ORDER BY COUNT(*) DESC
          LIMIT 6`, [since]),
    ]);

    const byStatus: Record<InboundTaskStatus, number> = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    let taskBytes = BigInt(0);
    for (const row of taskRows) {
      byStatus[row.status] = Number(row.count);
      taskBytes += BigInt(row.bytes ?? 0);
    }

    const snapshot = { queued: 0, running: 0 };
    for (const row of snapshotRows) {
      if (row.status === 'queued' || row.status === 'running') snapshot[row.status] = Number(row.count);
    }

    const trend = new Map<string, OverviewTrendRow>();
    for (const row of trendRows) {
      const key = isoTimestamp(row.bucket) ?? String(row.bucket);
      const entry = trend.get(key) ?? { bucket: key, queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, total: 0 };
      const count = Number(row.count);
      entry[row.status] = count;
      entry.total += count;
      trend.set(key, entry);
    }

    const grantByStatus: Record<'active' | 'expired' | 'revoked', number> = { active: 0, expired: 0, revoked: 0 };
    let grantTotal = 0;
    let downloads = 0;
    for (const row of grantRows) {
      const count = Number(row.count);
      grantByStatus[row.status] += count;
      grantTotal += count;
      downloads += Number(row.downloads ?? 0);
    }

    const terminal = byStatus.completed + byStatus.failed + byStatus.cancelled;
    return {
      timeRange,
      generatedAt: now.toISOString(),
      queue: {
        total: terminal + byStatus.queued + byStatus.running,
        byStatus,
        pending: snapshot.queued,
        running: snapshot.running,
        bytes: taskBytes.toString(),
        successRate: terminal ? byStatus.completed / terminal : null,
      },
      grants: {
        total: grantTotal,
        byStatus: grantByStatus,
        activeNow: Number(activeRows[0]?.count ?? 0),
        downloads,
      },
      trend: [...trend.values()],
      topBots: botRows.map(row => ({
        receiverBotId: row.receiverBotId,
        total: Number(row.total),
        failed: Number(row.failed),
        bytes: String(row.bytes ?? '0'),
      })),
    };
  }
}
