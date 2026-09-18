import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AuditService } from '../common/services/audit.service';
import { AuditStatus } from '../common/entities/audit-log.entity';
import {
  databaseCast,
  databaseDateBucket,
  getDatabaseType,
  type DatabaseType,
} from '../database/database-types';
import { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';
import { TelegramBotGrantService } from './telegram-bot-grant.service';
import { TelegramBotQuotaService } from './telegram-bot-quota.service';
import { TelegramBotConfigService } from './telegram-bot-config.service';
import { TelegramBotIdentity } from './telegram-bot.types';

export interface BotUsageTrendRow {
  bucket: string;
  /** @deprecated 兼容旧前端：等于 requests（HTTP 请求数，不是完整下载数） */
  downloads: number;
  /** HTTP 请求数（含完整、分段与中断） */
  requests: number;
  /** 其中 Range 分段（206）请求数 */
  ranged: number;
  /** 完整写完响应的请求数 */
  completed: number;
  /** 被中断的请求数 */
  aborted: number;
  bytes: string;
  /** 同一时间桶内 Bot 收到的文件数（来源 telegram_bot_file_grants） */
  files: number;
  /** 同一时间桶内收到文件的总大小（字节，字符串以兼容 bigint） */
  fileBytes: string;
}

export interface BotUsageSummary {
  timeRange: string;
  /** HTTP 请求数（含完整与分段、含中断） */
  requests: number;
  /** Range 分段（206）请求数：**断点续传是否真的发生，看这个值** */
  rangedRequests: number;
  /** 完整写完响应的请求数 */
  completedRequests: number;
  /** 被中断的请求数（客户端断开 / 上游失败 / 超时 / 服务关闭） */
  abortedRequests: number;
  /** 中断原因分布（terminationReason → 次数；不含 completed） */
  abortedByReason: Record<string, number>;
  uniqueUsers: number;
  totalBytes: string;
  /**
   * @deprecated 兼容旧前端：历史上该字段就是「HTTP 请求数」而非完整下载数。
   * 新前端请使用 requests / rangedRequests / completedRequests / abortedRequests。
   */
  downloads: number;
  /** 时间窗口内 Bot 收到的文件数（成功签发直链的 grant 数） */
  filesReceived: number;
  /** 时间窗口内收到文件的总大小（字节，字符串以兼容 bigint） */
  receivedBytes: string;
  trend: BotUsageTrendRow[];
}

/** Bot 用户明细行（按 TG 用户 ID 聚合） */
export interface BotUserRow {
  telegramUserId: string;
  /** 该用户最新一次非空的 @username 快照（用户可控，仅展示；**不是昵称**） */
  telegramUsername: string | null;
  filesReceived: number;
  receivedBytes: string;
  /** 其文件被访问次数（grants.accessCount 之和，累计口径，不受时间范围影响） */
  downloads: number;
  lastReceivedAt: Date | string | null;
  lastAccessedAt: Date | string | null;
}

export interface BotUserBreakdown {
  total: number;
  page: number;
  pageSize: number;
  rows: BotUserRow[];
}

const TIME_RANGE_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** 用户明细可选时间范围；`all` 表示不限时间（便于按 ID/用户名定点排查） */
const USER_BREAKDOWN_RANGES: Record<string, number | null> = {
  '1h': TIME_RANGE_MS['1h'],
  '24h': TIME_RANGE_MS['24h'],
  '7d': TIME_RANGE_MS['7d'],
  '30d': TIME_RANGE_MS['30d'],
  all: null,
};

const DEFAULT_USER_PAGE_SIZE = 20;
const MAX_USER_PAGE_SIZE = 100;
/** 关键字上限：仅用于 LIKE 模糊匹配，超长无意义且放大查询代价 */
const MAX_KEYWORD_LENGTH = 64;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/**
 * 跨方言把布尔列求和成次数。
 * PG 为 `boolean`、SQLite 为 0/1，`CASE WHEN` 在两侧语义一致；
 * NULL（未分类的普通请求与本次升级前的历史行）计为 0。
 */
function sumFlag(column: string): string {
  return `COALESCE(SUM(CASE WHEN ${column} THEN 1 ELSE 0 END), 0)`;
}

/** 带宽口径：优先实际正文字节，历史行回退 responseSize（含响应头的估算值） */
const BANDWIDTH_EXPR = 'COALESCE(SUM(COALESCE("responseBodyBytes", "responseSize")), 0)';

/**
 * Bot 管理能力：管理员身份判定、白名单维护、直链查询/撤销，以及 Bot 使用情况汇总。
 *
 * 安全约束：
 * - 身份一律以数字 TG 用户 ID 判定（`@username` 绝不参与权限判定，R6）；
 * - 审计只记 Token 前缀与 grantId，绝不记完整 Token/URL（R12）；
 * - 所有管理动作全审计（D11）。
 */
@Injectable()
export class TelegramBotAdminService {
  constructor(
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly grantService: TelegramBotGrantService,
    private readonly quotaService: TelegramBotQuotaService,
    private readonly configServiceForDomain: TelegramBotConfigService,
    private readonly dataSource: DataSource,
  ) {}

  /** 管理员集合（env 固定超管；第一版不引入 DB 管理员表） */
  getAdminIds(): Set<string> {
    const raw = this.configService.get<string>('TELEGRAM_BOT_ADMIN_IDS') || '';
    return new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^\d{1,20}$/.test(s)),
    );
  }

  isAdmin(telegramUserId: string): boolean {
    return this.getAdminIds().has(telegramUserId);
  }

  /** 越权调用管理命令的审计（不泄露命令内容） */
  auditCommandDenied(identity: TelegramBotIdentity, command: string, chatType: string): void {
    this.auditService.log({
      action: 'telegram_bot_command_denied',
      resourceType: 'telegram_bot_command',
      resourceId: command,
      status: AuditStatus.FAILURE,
      metadata: {
        telegramUserId: identity.telegramUserId,
        telegramUsername: identity.username,
        chatType,
        command,
      },
    });
  }

  // ---------------- 白名单 ----------------

  async addWhitelist(
    operator: TelegramBotIdentity,
    targetUserId: string,
  ): Promise<{ created: boolean }> {
    const result = await this.quotaService.addToWhitelist(targetUserId, operator.telegramUserId, 'admin');
    this.auditService.log({
      action: 'telegram_bot_whitelist_add',
      resourceType: 'telegram_bot_whitelist',
      resourceId: targetUserId,
      metadata: {
        operatorTelegramUserId: operator.telegramUserId,
        operatorTelegramUsername: operator.username,
        targetTelegramUserId: targetUserId,
        created: result.created,
      },
    });
    return result;
  }

  async removeWhitelist(operator: TelegramBotIdentity, targetUserId: string): Promise<boolean> {
    const removed = await this.quotaService.removeFromWhitelist(targetUserId);
    this.auditService.log({
      action: 'telegram_bot_whitelist_remove',
      resourceType: 'telegram_bot_whitelist',
      resourceId: targetUserId,
      metadata: {
        operatorTelegramUserId: operator.telegramUserId,
        operatorTelegramUsername: operator.username,
        targetTelegramUserId: targetUserId,
        removed,
      },
    });
    return removed;
  }

  async listWhitelist(): Promise<{ telegramUserId: string; createdAt: Date }[]> {
    const list = await this.quotaService.listWhitelist();
    return list.map((item) => ({ telegramUserId: item.telegramUserId, createdAt: item.createdAt }));
  }

  // ---------------- 直链查询 / 撤销 ----------------

  /**
   * 按 TG 用户 ID 查询**完整有效直链**（D11）。
   * 每次调用全审计，审计只记录查询者/目标与命中条数，不记完整链接。
   */
  async queryLinks(
    operator: TelegramBotIdentity,
    targetUserId: string,
  ): Promise<{ url: string | null; grant: TelegramBotFileGrant; prefix: string }[]> {
    const grants = await this.grantService.listActiveByUser(targetUserId);
    const origin = await this.configServiceForDomain.resolveSiteOriginAsync();
    const results = grants.map((grant) => {
      const token = this.grantService.replayToken(grant);
      return {
        grant,
        prefix: grant.tokenPrefix,
        url: token && origin ? this.grantService.buildUrl(origin, token) : null,
      };
    });

    this.auditService.log({
      action: 'telegram_bot_link_queried',
      resourceType: 'telegram_bot_grant',
      resourceId: targetUserId,
      metadata: {
        operatorTelegramUserId: operator.telegramUserId,
        operatorTelegramUsername: operator.username,
        targetTelegramUserId: targetUserId,
        hitCount: results.length,
        replayable: results.filter((r) => r.url !== null).length,
      },
    });
    return results;
  }

  /** 从直链 URL 或裸 Token 中提取 Token（D12） */
  extractToken(input: string): string | null {
    const raw = input.trim();
    if (!raw) return null;
    // 完整 URL：取最后一段路径
    if (/^https?:\/\//i.test(raw)) {
      try {
        const url = new URL(raw);
        const segments = url.pathname.split('/').filter(Boolean);
        const last = segments[segments.length - 1];
        return last && /^[A-Za-z0-9_-]{16,}$/.test(last) ? last : null;
      } catch {
        return null;
      }
    }
    return /^[A-Za-z0-9_-]{16,}$/.test(raw) ? raw : null;
  }

  /** 按直链 URL/Token 撤销（D12）；审计只记 grantId 与前缀 */
  async revokeByToken(
    operator: TelegramBotIdentity,
    tokenOrUrl: string,
  ): Promise<{ ok: boolean; reason?: string; grant?: TelegramBotFileGrant }> {
    const token = this.extractToken(tokenOrUrl);
    if (!token) {
      return { ok: false, reason: 'invalid_input' };
    }
    const prefix = this.grantService.tokenPrefixOf(token);
    const grant = await this.grantService.findByToken(token);
    if (!grant) {
      this.auditService.log({
        action: 'telegram_bot_link_revoked',
        resourceType: 'telegram_bot_grant',
        status: AuditStatus.FAILURE,
        metadata: {
          operatorTelegramUserId: operator.telegramUserId,
          operatorTelegramUsername: operator.username,
          tokenPrefix: prefix,
          reason: 'not_found',
        },
      });
      return { ok: false, reason: 'not_found' };
    }

    const revoked = await this.grantService.revoke(grant, operator.telegramUserId);
    this.auditService.log({
      action: 'telegram_bot_link_revoked',
      resourceType: 'telegram_bot_grant',
      resourceId: grant.id,
      metadata: {
        operatorTelegramUserId: operator.telegramUserId,
        operatorTelegramUsername: operator.username,
        grantId: grant.id,
        tokenPrefix: grant.tokenPrefix,
        targetTelegramUserId: grant.telegramUserId,
        alreadyRevoked: !revoked,
      },
    });
    return { ok: true, grant };
  }

  // ---------------- Bot 使用情况（D13） ----------------

  /**
   * Bot 使用情况汇总（SQL 侧聚合，bigint 安全）。
   *
   * 两个数据源刻意分开：
   * - 「下载」侧（下载次数/去重下载用户/带宽/下载趋势）来自 `access_logs`；
   * - 「收到文件」侧（文件数/总大小/收到趋势）来自 `telegram_bot_file_grants`——
   *   即 Bot 收到文件并成功签发直链的记录（被配额拒绝的文件不会落库，故不计入）。
   * 两张表的时间桶用同一 `databaseDateBucket` 表达式与同一粒度，按桶键合并成一条趋势。
   */
  async getUsageSummary(timeRange = '7d'): Promise<BotUsageSummary> {
    const type = getDatabaseType();
    const range = TIME_RANGE_MS[timeRange] ? timeRange : '7d';
    const since = new Date(Date.now() - TIME_RANGE_MS[range]);
    const sinceParam = type === 'sqlite'
      ? since.toISOString().replace('T', ' ').replace('Z', '')
      : since;

    const where = `"botGrantId" IS NOT NULL AND "createdAt" >= $1`;
    const receivedWhere = `"createdAt" >= $1`;

    // 趋势粒度与时间范围匹配（与 getAccessLogTrend 口径一致）：1h 按分钟、
    // 24h/7d 按小时、30d 按天。固定按天会让短范围只产生一个点，趋势图失去意义。
    const bucketUnit: 'minute' | 'hour' | 'day' =
      range === '1h' ? 'minute' : range === '30d' ? 'day' : 'hour';
    const bucket = databaseDateBucket('"createdAt"', bucketUnit);

    const [totals, trendRows, reasonRows, receivedTotals, receivedTrendRows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*) AS "requests",
                COUNT(DISTINCT "botTelegramUserId") AS "uniqueUsers",
                ${sumFlag('"ranged"')} AS "rangedRequests",
                ${sumFlag('"transferCompleted"')} AS "completedRequests",
                ${sumFlag('"transferAborted"')} AS "abortedRequests",
                ${databaseCast(BANDWIDTH_EXPR, 'bigint')} AS "totalBytes"
           FROM "access_logs"
          WHERE ${where}`,
        [sinceParam],
      ),
      this.dataSource.query(
        `SELECT ${bucket} AS "bucket",
                COUNT(*) AS "requests",
                ${sumFlag('"ranged"')} AS "ranged",
                ${sumFlag('"transferCompleted"')} AS "completed",
                ${sumFlag('"transferAborted"')} AS "aborted",
                ${databaseCast(BANDWIDTH_EXPR, 'bigint')} AS "bytes"
           FROM "access_logs"
          WHERE ${where}
          GROUP BY ${bucket}
          ORDER BY ${bucket} ASC`,
        [sinceParam],
      ),
      // 中断原因分布：用于区分「客户端主动断开」与「上游失败 / 超时 / 服务关闭」
      this.dataSource.query(
        `SELECT "terminationReason" AS "reason", COUNT(*) AS "count"
           FROM "access_logs"
          WHERE ${where}
            AND "terminationReason" IS NOT NULL
            AND "terminationReason" <> 'completed'
          GROUP BY "terminationReason"`,
        [sinceParam],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS "filesReceived",
                ${databaseCast('COALESCE(SUM("fileSize"), 0)', 'bigint')} AS "receivedBytes"
           FROM "telegram_bot_file_grants"
          WHERE ${receivedWhere}`,
        [sinceParam],
      ),
      this.dataSource.query(
        `SELECT ${bucket} AS "bucket",
                COUNT(*) AS "files",
                ${databaseCast('COALESCE(SUM("fileSize"), 0)', 'bigint')} AS "fileBytes"
           FROM "telegram_bot_file_grants"
          WHERE ${receivedWhere}
          GROUP BY ${bucket}
          ORDER BY ${bucket} ASC`,
        [sinceParam],
      ),
    ]);

    const totalRow = Array.isArray(totals) && totals.length > 0 ? totals[0] : {};
    const receivedRow = Array.isArray(receivedTotals) && receivedTotals.length > 0 ? receivedTotals[0] : {};
    const requests = Number(totalRow.requests ?? 0);
    return {
      timeRange: range,
      requests,
      rangedRequests: Number(totalRow.rangedRequests ?? 0),
      completedRequests: Number(totalRow.completedRequests ?? 0),
      abortedRequests: Number(totalRow.abortedRequests ?? 0),
      abortedByReason: this.toReasonCounts(reasonRows),
      uniqueUsers: Number(totalRow.uniqueUsers ?? 0),
      totalBytes: String(totalRow.totalBytes ?? '0'),
      // 兼容旧前端：旧字段语义一直是「请求数」
      downloads: requests,
      filesReceived: Number(receivedRow.filesReceived ?? 0),
      receivedBytes: String(receivedRow.receivedBytes ?? '0'),
      trend: this.mergeUsageTrend(trendRows, receivedTrendRows),
    };
  }

  /** 中断原因分布行 → { reason: count } */
  private toReasonCounts(rows: unknown): Record<string, number> {
    const result: Record<string, number> = {};
    if (!Array.isArray(rows)) return result;
    for (const row of rows as Record<string, unknown>[]) {
      const reason = row.reason === null || row.reason === undefined ? '' : String(row.reason);
      if (!reason) continue;
      result[reason] = Number(row.count ?? 0);
    }
    return result;
  }

  /**
   * 按时间桶合并「下载」与「收到文件」两条趋势。
   *
   * 桶键在同一方言内形态一致（均为 `databaseDateBucket` 的产物：PG 为 Date、
   * SQLite 为时间字符串），故可用键直接对齐；排序沿用数值时间，避免
   * PG `Date.toString()` 的星期前缀导致字典序错乱。
   */
  private mergeUsageTrend(
    downloadRows: unknown,
    receivedRows: unknown,
  ): BotUsageTrendRow[] {
    const keyOf = (bucket: unknown): string =>
      bucket instanceof Date ? bucket.toISOString() : String(bucket);

    const merged = new Map<string, BotUsageTrendRow>();
    const rows = (source: unknown): Record<string, unknown>[] =>
      Array.isArray(source) ? (source as Record<string, unknown>[]) : [];

    for (const row of rows(downloadRows)) {
      const requests = Number(row.requests ?? 0);
      merged.set(keyOf(row.bucket), {
        bucket: String(row.bucket),
        downloads: requests,
        requests,
        ranged: Number(row.ranged ?? 0),
        completed: Number(row.completed ?? 0),
        aborted: Number(row.aborted ?? 0),
        bytes: String(row.bytes ?? '0'),
        files: 0,
        fileBytes: '0',
      });
    }
    for (const row of rows(receivedRows)) {
      const key = keyOf(row.bucket);
      const files = Number(row.files ?? 0);
      const fileBytes = String(row.fileBytes ?? '0');
      const existing = merged.get(key);
      if (existing) {
        existing.files = files;
        existing.fileBytes = fileBytes;
      } else {
        merged.set(key, {
          bucket: String(row.bucket),
          downloads: 0,
          requests: 0,
          ranged: 0,
          completed: 0,
          aborted: 0,
          bytes: '0',
          files,
          fileBytes,
        });
      }
    }

    const timeOf = (bucket: string): number => {
      const parsed = new Date(bucket).getTime();
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    return [...merged.values()].sort((a, b) => timeOf(a.bucket) - timeOf(b.bucket));
  }

  /**
   * Bot 用户明细：按 TG 用户 ID 聚合收到文件、总大小与被下载次数。
   *
   * - 数据源为 `telegram_bot_file_grants`（含用户身份快照），因此**能直接给出
   *   @用户名**；`access_logs` 只存了数字用户 ID，无法单独支撑该视图；
   * - 用户名取该用户最新一次非空的 @username 快照（TG 允许改名，快照会滞后）；
   *   明确**不返回 `telegramDisplayName`（昵称）**，按需求只暴露 ID 与用户名；
   * - 关键字同时匹配用户 ID 与用户名（大小写不敏感），`%`/`_`/`\` 已转义。
   */
  async getUserBreakdown(options: {
    keyword?: string;
    timeRange?: string;
    page?: number;
    pageSize?: number;
  } = {}): Promise<BotUserBreakdown> {
    const type = getDatabaseType();
    const pageSize = clampInt(options.pageSize, DEFAULT_USER_PAGE_SIZE, 1, MAX_USER_PAGE_SIZE);
    const totalPagesSafe = Number.MAX_SAFE_INTEGER / pageSize;
    const page = clampInt(options.page, 1, 1, Math.max(1, Math.floor(totalPagesSafe)));
    const offset = (page - 1) * pageSize;

    const { where, params } = this.buildUserBreakdownFilters(options.keyword, options.timeRange, type);
    const limitParam = `$${params.length + 1}`;
    const offsetParam = `$${params.length + 2}`;

    const rows = await this.dataSource.query(
      `SELECT g."telegramUserId" AS "telegramUserId",
              COUNT(*) AS "filesReceived",
              ${databaseCast('COALESCE(SUM(g."fileSize"), 0)', 'bigint')} AS "receivedBytes",
              ${databaseCast('COALESCE(SUM(g."accessCount"), 0)', 'bigint')} AS "downloads",
              MAX(g."createdAt") AS "lastReceivedAt",
              MAX(g."lastAccessedAt") AS "lastAccessedAt",
              (SELECT g2."telegramUsername"
                 FROM "telegram_bot_file_grants" g2
                WHERE g2."telegramUserId" = g."telegramUserId"
                  AND g2."telegramUsername" IS NOT NULL
                ORDER BY g2."createdAt" DESC
                LIMIT 1) AS "telegramUsername"
         FROM "telegram_bot_file_grants" g
        WHERE ${where}
        GROUP BY g."telegramUserId"
        ORDER BY COUNT(*) DESC, g."telegramUserId" ASC
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
      [...params, pageSize, offset],
    );

    const countRows = await this.dataSource.query(
      `SELECT COUNT(DISTINCT g."telegramUserId") AS "total"
         FROM "telegram_bot_file_grants" g
        WHERE ${where}`,
      params,
    );

    const totalRow = Array.isArray(countRows) && countRows.length > 0 ? countRows[0] : {};
    const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    return {
      total: Number(totalRow.total ?? 0),
      page,
      pageSize,
      rows: list.map((row) => ({
        telegramUserId: String(row.telegramUserId),
        telegramUsername: row.telegramUsername ? String(row.telegramUsername) : null,
        filesReceived: Number(row.filesReceived ?? 0),
        receivedBytes: String(row.receivedBytes ?? '0'),
        downloads: Number(row.downloads ?? 0),
        lastReceivedAt: (row.lastReceivedAt as Date | string | null) ?? null,
        lastAccessedAt: (row.lastAccessedAt as Date | string | null) ?? null,
      })),
    };
  }

  /** 用户明细筛选条件（时间范围 + 关键字），返回拼接好的 WHERE 与按序参数 */
  private buildUserBreakdownFilters(
    keyword: string | undefined,
    timeRange: string | undefined,
    type: DatabaseType,
  ): { where: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    const range = timeRange && timeRange in USER_BREAKDOWN_RANGES ? timeRange : 'all';
    const windowMs = USER_BREAKDOWN_RANGES[range];
    if (windowMs !== null) {
      const since = new Date(Date.now() - windowMs);
      params.push(type === 'sqlite' ? since.toISOString().replace('T', ' ').replace('Z', '') : since);
      conditions.push(`g."createdAt" >= $${params.length}`);
    }

    const like = this.buildUserKeywordPattern(keyword);
    if (like) {
      const idIndex = params.length + 1;
      const nameIndex = params.length + 2;
      params.push(like, like);
      // 用户名按 @username 存储（含 @ 前缀），统一小写比较以兼容 SQLite/PG 大小写差异
      conditions.push(
        `(g."telegramUserId" LIKE $${idIndex} ESCAPE '\\'`
        + ` OR LOWER(g."telegramUsername") LIKE $${nameIndex} ESCAPE '\\')`,
      );
    }

    return { where: conditions.length > 0 ? conditions.join(' AND ') : '1=1', params };
  }

  /** LIKE 模式：转义通配符并小写；空关键字返回 null（不做过滤） */
  private buildUserKeywordPattern(keyword: string | undefined): string | null {
    const raw = (keyword || '').trim().toLowerCase().slice(0, MAX_KEYWORD_LENGTH);
    if (!raw) return null;
    return `%${raw.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  }
}
