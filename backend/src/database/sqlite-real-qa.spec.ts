import { randomUUID } from 'crypto';
import { rm } from 'fs/promises';
import { join } from 'path';
import { DataSource } from 'typeorm';

const DB_PATH = join(process.cwd(), 'tmp', `sqlite-real-qa-${process.pid}-${Date.now()}.sqlite`);
/**
 * 建库/迁移/销毁的真实耗时在并行跑整套 Jest 时会超过默认 5s（DataSource 初始化 +
 * 完整迁移链 + PRAGMA），导致整组用例因 beforeAll 超时而全灭。此处显式放宽，
 * 使失败只反映真实缺陷而非机器负载。
 */
const DB_SETUP_TIMEOUT_MS = 30_000;

describe('真实 SQLite 数据源关键业务与并发 QA', () => {
  let dataSource: DataSource;
  let secondDataSource: DataSource;
  const originalDbType = process.env.DB_TYPE;
  const originalDatabase = process.env.DB_DATABASE;

  beforeAll(async () => {
    process.env.DB_TYPE = 'sqlite';
    process.env.DB_DATABASE = DB_PATH;
    jest.resetModules();
    const { createDatabaseOptions } = require('./database.config') as typeof import('./database.config');
    dataSource = new DataSource(createDatabaseOptions({
      ...process.env,
      DB_TYPE: 'sqlite',
      DB_DATABASE: DB_PATH,
      DB_MIGRATIONS_RUN: 'false',
      DB_SQLITE_BUSY_TIMEOUT_MS: '10',
    }));
    await dataSource.initialize();
    await dataSource.runMigrations();
    await dataSource.query('PRAGMA foreign_keys = ON');
  }, DB_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (secondDataSource?.isInitialized) await secondDataSource.destroy();
    if (dataSource?.isInitialized) await dataSource.destroy();
    await rm(DB_PATH, { force: true });
    if (originalDbType === undefined) delete process.env.DB_TYPE;
    else process.env.DB_TYPE = originalDbType;
    if (originalDatabase === undefined) delete process.env.DB_DATABASE;
    else process.env.DB_DATABASE = originalDatabase;
  }, DB_SETUP_TIMEOUT_MS);

  it('迁移升级、安全 revert、重放及完整性检查均保留业务数据', async () => {
    const userId = randomUUID();
    await dataSource.query(
      'INSERT INTO users (id, email, password, role, "isBanned", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [userId, 'migration-qa@example.com', 'hash', 'user'],
    );

    const appliedBefore = await dataSource.query('SELECT name FROM migrations ORDER BY timestamp');
    expect(appliedBefore.map((row: { name: string }) => row.name)).toEqual([
      'SqliteEntitySchema1700000000000',
      'SqliteCreateUpdateTasks1798400000000',
      'SqliteSchemaAlignment1800000000000',
      'SqliteCreateApiKeys1801000000000',
      // v1.2.6：私密分享安全回填 / 统一目录命名空间 / API 密钥安全治理
      'SqliteRevokePrivateLegacyShares1802000000000',
      'SqliteCreateDirectoryNames1802100000000',
      'SqliteApiKeySecurityGovernance1802200000000',
      // v1.2.9：Telegram Bot 文件直链
      'SqliteTelegramBotLinks1802300000000',
      // v1.3.3：下载任务持久化（下载磁盘配额与排队）
      'SqliteCreateDownloadTasks1802500000000',
      // v1.4.0：access_logs 传输结果字段（续传 / 中断 / 结束原因）
      'SqliteAddAccessLogTransferFields1802600000000',
      // v1.5.0：Telegram 文件副本表（多账号回源）+ grants 源账号锚点
      'SqliteTelegramFileCopies1802900000000',
      // v1.5.2：账号池后台管理（账号主数据）+ 镜像规则/任务 + files 主副本定位字段
      'SqliteCreateTelegramAccounts1803000000000',
      'SqliteCreateTelegramMirror1803100000000',
      'SqliteAddFileTelegramSourceFields1803200000000',
      // v1.5.4：入站副本 → 站内文件桥接（files.telegramFileUniqueId 索引）
      'SqliteAddFileTelegramUniqueIdIndex1803300000000',
      // v1.5.5：副本锚点一致性（按账号维度的部分唯一索引 + 锚点覆盖索引）
      'SqliteTelegramCopyAnchorGuard1803400000000',
      // 副本扩散改造：中继轮次持久化（策略 B 唯一链路的可观测性底座）
      'SqliteCreateTelegramReplicationAttempts1803500000000',
      // 副本扩散改造：主群锚点（「Bot 先搬进主群 → userbot 再转发到镜像群」的落点）
      'SqliteCreateTelegramMainChatAnchors1803600000000',
    ]);

    await dataSource.undoLastMigration();
    expect(await dataSource.query('SELECT email FROM users WHERE id = ?', [userId])).toHaveLength(1);
    await dataSource.runMigrations();
    expect(await dataSource.query('SELECT email FROM users WHERE id = ?', [userId])).toHaveLength(1);

    const integrity = await dataSource.query('PRAGMA integrity_check');
    const foreignKeys = await dataSource.query('PRAGMA foreign_key_check');
    expect(Object.values(integrity[0])).toEqual(['ok']);
    expect(foreignKeys).toEqual([]);
  });

  it('API 密钥真实创建由 UuidSubscriber 生成 UUID，摘要落库、明文不落库', async () => {
    const { ApiKey } = require('../common/entities/api-key.entity') as typeof import('../common/entities/api-key.entity');
    const { ApiKeyService } = require('../api-key/api-key.service') as typeof import('../api-key/api-key.service');
    const { User } = require('../common/entities/user.entity') as typeof import('../common/entities/user.entity');
    const userRepo = dataSource.getRepository(User);
    const user = await userRepo.save(userRepo.create({
      email: `apikey-${randomUUID()}@example.com`, password: 'hash',
    }));
    const audit = { log: jest.fn(), logAwait: jest.fn() } as any;
    // v1.2.6：加密服务以不可用模式注入（密钥不可重显）；白名单/使用审计依赖真实仓库与 stub
    const crypto = { isAvailable: () => false, encrypt: () => null, decrypt: () => null } as any;
    const usage = { record: jest.fn(), assertKeyOwnedForMutation: jest.fn() } as any;
    const service = new ApiKeyService(
      dataSource.getRepository(ApiKey),
      userRepo,
      dataSource.getRepository(require('../common/entities/api-key-ip-allowlist.entity').ApiKeyIpAllowlist),
      audit,
      crypto,
      usage,
    );

    // PG 侧该路径曾因建表迁移遗漏 id DEFAULT 而 23502；SQLite 依赖
    // subscriber 应用层生成 id，此测试防止该生成链路回归。
    const created = await service.create(user, 'SQLite 回归');
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.key.startsWith('tgtc_')).toBe(true);

    const row = await dataSource.getRepository(ApiKey).findOneByOrFail({ id: created.id });
    expect(row.keyHash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(created.key);

    const rotated = await service.rotate(user, created.id);
    expect(rotated.id).not.toBe(created.id);
    expect((await dataSource.getRepository(ApiKey).findOneByOrFail({ id: created.id })).revokedAt)
      .toBeInstanceOf(Date);
  });

  it('限流原子计数在并发调用下准确达到阈值', async () => {
    const { RateLimit } = require('../common/entities/rate-limit.entity') as typeof import('../common/entities/rate-limit.entity');
    const { RateLimitService } = require('../common/services/rate-limit.service') as typeof import('../common/services/rate-limit.service');
    const service = new RateLimitService(dataSource.getRepository(RateLimit));
    const key = `qa:${randomUUID()}`;

    const results = await Promise.all(Array.from({ length: 8 }, () =>
      service.checkAndIncrement(key, 'qa', 5, 60_000, 60_000),
    ));
    const row = await dataSource.getRepository(RateLimit).findOneByOrFail({ key });
    expect(row.attemptCount).toBe(5);
    expect(row.lockedUntil).toBeInstanceOf(Date);
    expect(results.filter((result) => result.allowed)).toHaveLength(4);
    expect(results.filter((result) => !result.allowed)).toHaveLength(4);

    const oneShot = await service.checkAndIncrement(`qa-one:${randomUUID()}`, 'qa', 1, 60_000, 60_000);
    expect(oneShot.allowed).toBe(false);
  });

  it('Bot 每日配额并发扣减原子精确，白名单仅永久增删', async () => {
    const { TelegramBotDailyUsage } = require('../common/entities/telegram-bot-daily-usage.entity') as typeof import('../common/entities/telegram-bot-daily-usage.entity');
    const { TelegramBotWhitelist } = require('../common/entities/telegram-bot-whitelist.entity') as typeof import('../common/entities/telegram-bot-whitelist.entity');
    const { TelegramBotQuotaService } = require('../telegram-bot/telegram-bot-quota.service') as typeof import('../telegram-bot/telegram-bot-quota.service');

    const service = new TelegramBotQuotaService(
      dataSource.getRepository(TelegramBotDailyUsage),
      dataSource.getRepository(TelegramBotWhitelist),
      dataSource,
    );

    // 切日时区按 IANA 计算业务日期：UTC 20:00 → Asia/Shanghai 次日
    expect(service.getBusinessDate('Asia/Shanghai', new Date('2026-09-15T20:00:00Z'))).toBe('2026-09-16');
    expect(service.getBusinessDate('Asia/Shanghai', new Date('2026-09-15T10:00:00Z'))).toBe('2026-09-15');

    const tgUserId = `qa-${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.consume(tgUserId, '2026-09-15', 5)),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(15);
    expect(await service.getUsed(tgUserId, '2026-09-15')).toBe(5);

    // 归还一次后额度恢复 1（失败补偿路径）
    await service.refund(tgUserId, '2026-09-15');
    expect(await service.getUsed(tgUserId, '2026-09-15')).toBe(4);

    expect(await service.isWhitelisted(tgUserId)).toBe(false);
    await service.addToWhitelist(tgUserId, '9001', 'admin');
    expect(await service.isWhitelisted(tgUserId)).toBe(true);
    // 重复加入幂等
    expect((await service.addToWhitelist(tgUserId, '9001', 'admin')).created).toBe(false);
    await service.removeFromWhitelist(tgUserId);
    expect(await service.isWhitelisted(tgUserId)).toBe(false);
  });

  it('Bot 直链 grant 以消息作幂等锚点，access_logs 已具备 Bot 标识列', async () => {
    const { TelegramBotFileGrant } = require('../common/entities/telegram-bot-file-grant.entity') as typeof import('../common/entities/telegram-bot-file-grant.entity');
    const repo = dataSource.getRepository(TelegramBotFileGrant);
    const base = {
      telegramUserId: '80000000000000001',
      telegramUsername: '@qa',
      telegramDisplayName: 'QA',
      chatId: '80000000000000001',
      messageId: '42',
      telegramFileId: 'fid-qa',
      fileName: 'qa.bin',
      mimeType: 'application/octet-stream',
      fileSize: '1024',
      tokenHash: 'a'.repeat(64),
      tokenCipher: null,
      tokenPrefix: 'tgl_aaaaaaaa',
      cipherVersion: null,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      revokedAt: null,
      revokedBy: null,
    };

    await repo.save(repo.create(base));
    await expect(
      repo.save(repo.create({ ...base, tokenHash: 'b'.repeat(64) })),
    ).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT' });

    const accessLogColumns = await dataSource.query(`PRAGMA table_info('access_logs')`);
    const names = accessLogColumns.map((column: { name: string }) => column.name);
    expect(names).toContain('botGrantId');
    expect(names).toContain('botTelegramUserId');

    // Bot 标识可写入 access_logs（供 bot-usage 汇总）
    const { AccessLog } = require('../common/entities/access-log.entity') as typeof import('../common/entities/access-log.entity');
    const accessRepo = dataSource.getRepository(AccessLog);
    await accessRepo.insert({
      ip: '127.0.0.1',
      method: 'GET',
      path: '/api/bot-dl/token',
      statusCode: 200,
      responseSize: 2048,
      duration: 5,
      userAgent: null,
      referer: null,
      userId: null,
      botGrantId: '11111111-1111-1111-1111-111111111111',
      botTelegramUserId: '80000000000000001',
    });
    const botRows = await accessRepo.count({ where: { botTelegramUserId: '80000000000000001' } });
    expect(botRows).toBe(1);

    // bot-usage 汇总必须在 SQL 侧聚合且与 access_logs 一致（D13）
    const { TelegramBotAdminService } = require('../telegram-bot/telegram-bot-admin.service') as typeof import('../telegram-bot/telegram-bot-admin.service');
    const adminService = new TelegramBotAdminService(
      { get: jest.fn() } as any,
      { log: jest.fn() } as any,
      { tokenPrefixOf: (t: string) => `tgl_${t.slice(0, 8)}` } as any,
      { listWhitelist: jest.fn(), addToWhitelist: jest.fn(), removeFromWhitelist: jest.fn() } as any,
      { resolveSiteOriginAsync: jest.fn() } as any,
      dataSource,
    );
    const usage = await adminService.getUsageSummary('24h');
    expect(usage).toMatchObject({ timeRange: '24h', downloads: 1, uniqueUsers: 1, totalBytes: '2048' });
    expect(usage.trend).toHaveLength(1);
    expect(usage.trend[0].bytes).toBe('2048');

    // 收到文件统计来自 telegram_bot_file_grants（同窗口），并与下载趋势按时间桶合并
    expect(usage).toMatchObject({ filesReceived: 1, receivedBytes: '1024' });
    expect(usage.trend[0]).toMatchObject({ downloads: 1, files: 1, fileBytes: '1024' });

    // 用户明细：SQL 侧聚合，直接给出 TG 用户 ID 与 @用户名（不含昵称），支持关键字筛选
    const breakdown = await adminService.getUserBreakdown({});
    expect(breakdown).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(breakdown.rows[0]).toMatchObject({
      telegramUserId: '80000000000000001',
      telegramUsername: '@qa',
      filesReceived: 1,
      receivedBytes: '1024',
      downloads: 0,
    });
    expect(breakdown.rows[0]).not.toHaveProperty('telegramDisplayName');
    expect((await adminService.getUserBreakdown({ keyword: '@QA' })).total).toBe(1);
    expect((await adminService.getUserBreakdown({ keyword: '80000000000000001' })).total).toBe(1);
    // LIKE 通配符已转义：未转义时 '8_0' 会命中 '80000000000000001'
    expect((await adminService.getUserBreakdown({ keyword: '8_0' })).total).toBe(0);
    expect((await adminService.getUserBreakdown({ timeRange: '24h' })).total).toBe(1);
    expect((await adminService.getUserBreakdown({ pageSize: 500 })).pageSize).toBe(100);

    // 清理：后续用例的访问日志统计断言基于全表，避免本用例污染计数
    await accessRepo.delete({ botTelegramUserId: '80000000000000001' });
  });

  it('文件夹、标签并发重名由唯一约束兜底，且外键拒绝孤儿记录', async () => {
    const { User } = require('../common/entities/user.entity') as typeof import('../common/entities/user.entity');
    const { File } = require('../common/entities/file.entity') as typeof import('../common/entities/file.entity');
    const { Folder } = require('../common/entities/folder.entity') as typeof import('../common/entities/folder.entity');
    const { Tag } = require('../common/entities/tag.entity') as typeof import('../common/entities/tag.entity');
    const { FolderService } = require('../folder/folder.service') as typeof import('../folder/folder.service');
    const { TagService } = require('../tag/tag.service') as typeof import('../tag/tag.service');
    const owner = await dataSource.getRepository(User).save(dataSource.getRepository(User).create({
      email: `owner-${randomUUID()}@example.com`, password: 'hash',
    }));
    const audit = { log: jest.fn(), logAwait: jest.fn() } as any;
    const namespace = {
      acquire: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
      releaseMany: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
      reactivateMany: jest.fn(async () => undefined),
      isNameTaken: jest.fn(async () => false),
    } as any;
    const folderService = new FolderService(dataSource.getTreeRepository(Folder), dataSource.getRepository(File), audit, namespace);
    const tagService = new TagService(dataSource.getRepository(Tag), audit, dataSource);

    const folderResults = await Promise.allSettled([
      folderService.createFolder(owner.id, { name: '并发目录' }),
      folderService.createFolder(owner.id, { name: '并发目录' }),
    ]);
    expect(folderResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(folderResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((folderResults.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toMatchObject({ status: 409, message: '同层级下已存在同名文件夹' });

    const tagResults = await Promise.allSettled([
      tagService.create(owner.id, { name: '并发标签', color: '#0052d9' }),
      tagService.create(owner.id, { name: '并发标签', color: '#0052d9' }),
    ]);
    expect(tagResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(tagResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((tagResults.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toMatchObject({ status: 409, message: '标签名称已存在' });

    await expect(dataSource.query(
      'INSERT INTO folders (id, name, "ownerId", "isDeleted") VALUES (?, ?, ?, 0)',
      [randomUUID(), '孤儿目录', randomUUID()],
    )).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT' });
  });

  it('分享、告警、管理员封禁、统计与后台清理在真实仓储上闭环', async () => {
    jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }), { virtual: true });
    const { User } = require('../common/entities/user.entity') as typeof import('../common/entities/user.entity');
    const { File } = require('../common/entities/file.entity') as typeof import('../common/entities/file.entity');
    const { Folder } = require('../common/entities/folder.entity') as typeof import('../common/entities/folder.entity');
    const { ShareLink, ShareTargetType } = require('../common/entities/share-link.entity') as typeof import('../common/entities/share-link.entity');
    const { Alert, AlertLevel } = require('../common/entities/alert.entity') as typeof import('../common/entities/alert.entity');
    const { BannedIP } = require('../common/entities/banned-ip.entity') as typeof import('../common/entities/banned-ip.entity');
    const { SystemConfig } = require('../common/entities/system-config.entity') as typeof import('../common/entities/system-config.entity');
    const { FileAccessLog } = require('../common/entities/file-access-log.entity') as typeof import('../common/entities/file-access-log.entity');
    const { AccessLog } = require('../common/entities/access-log.entity') as typeof import('../common/entities/access-log.entity');
    const { AuditLog } = require('../common/entities/audit-log.entity') as typeof import('../common/entities/audit-log.entity');
    const { ShareAudit } = require('../common/entities/share-audit.entity') as typeof import('../common/entities/share-audit.entity');
    const { RateLimit } = require('../common/entities/rate-limit.entity') as typeof import('../common/entities/rate-limit.entity');
    const { JwtRevokedToken } = require('../common/entities/jwt-revoked-token.entity') as typeof import('../common/entities/jwt-revoked-token.entity');
    const { ShareService } = require('../share/share.service') as typeof import('../share/share.service');
    const { AlertService } = require('../alert/alert.service') as typeof import('../alert/alert.service');
    const { AdminService } = require('../admin/admin.service') as typeof import('../admin/admin.service');
    const { TasksService } = require('../tasks/tasks.service') as typeof import('../tasks/tasks.service');

    const userRepo = dataSource.getRepository(User);
    const fileRepo = dataSource.getRepository(File);
    const owner = await userRepo.save(userRepo.create({ email: `biz-${randomUUID()}@example.com`, password: 'hash' }));
    const file = await fileRepo.save(fileRepo.create({
      filename: 'qa.bin', originalName: 'qa.bin', mimeType: 'application/octet-stream', size: 10,
      telegramFileId: `qa-${randomUUID()}`, uploaderId: owner.id, status: 'ready', uploadStage: 'committed',
    }));
    const audit = { log: jest.fn(), logAwait: jest.fn().mockResolvedValue(undefined) } as any;
    const shareService = new ShareService(
      dataSource.getRepository(ShareLink), fileRepo, dataSource.getTreeRepository(Folder), audit,
      {} as any, {} as any, { get: jest.fn().mockReturnValue('http://localhost:3000') } as any,
      {} as any, {} as any,
    );
    const share = await shareService.createShare(owner.id, {
      targetType: ShareTargetType.FILE, targetId: file.id, maxAccessCount: 2,
    });
    expect(await dataSource.getRepository(ShareLink).findOneBy({ id: share.id })).toMatchObject({ targetId: file.id });

    const alertRepo = dataSource.getRepository(Alert);
    const alert = await alertRepo.save(alertRepo.create({
      ruleId: 'qa-rule', level: AlertLevel.WARNING, title: 'QA', message: '真实 SQLite 告警', context: {},
    }));
    await new AlertService(alertRepo).acknowledge(alert.id, owner.id);
    expect((await alertRepo.findOneByOrFail({ id: alert.id })).acknowledgedBy).toBe(owner.id);

    const admin = new AdminService(
      dataSource.getRepository(SystemConfig), dataSource.getRepository(BannedIP), fileRepo, userRepo,
      dataSource.getRepository(FileAccessLog), dataSource.getRepository(AccessLog), dataSource.getRepository(AuditLog),
      {} as any, {} as any, audit, {} as any, {} as any, {} as any,
    );
    await admin.banIP(owner, '198.51.100.7', 'QA', true);
    await expect(admin.banIP(owner, '198.51.100.7', 'QA duplicate', true)).rejects.toThrow('该IP已被封禁');
    expect(await dataSource.getRepository(BannedIP).countBy({ ip: '198.51.100.7' })).toBe(1);
    const stats = await admin.getStats();
    expect(stats.totalUsers).toBeGreaterThanOrEqual(1);
    expect(stats.totalFiles).toBeGreaterThanOrEqual(1);

    const accessLogRepo = dataSource.getRepository(AccessLog);
    await accessLogRepo.save([10, 20, 30, 40].map((duration, index) => accessLogRepo.create({
      ip: index % 2 ? '198.51.100.8' : '198.51.100.9', method: 'GET', path: '/qa', statusCode: 200,
      responseSize: 100 + index, duration, userAgent: 'qa', referer: null, userId: owner.id,
    })));
    const latency = await admin.getLatencyStats({ timeRange: '24h' });
    expect(latency).toMatchObject({ avgDuration: 25, p50Duration: 25, totalRequests: 4 });
    expect(latency.p95Duration).toBeCloseTo(38.5);
    expect(Array.isArray((await admin.getBandwidthAnalysis({ timeRange: '24h' })).trend)).toBe(true);
    expect((await admin.getFileTypeStats({})).categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '其他', fileCount: expect.any(Number) }),
    ]));
    expect((await admin.getUserActivityStats({ timeRange: '24h' })).topActiveUsers[0]).toMatchObject({ userId: owner.id });
    expect((await admin.getComparison('24h')).current.requests).toBeGreaterThanOrEqual(4);

    const expired = dataSource.getRepository(RateLimit).create({
      key: `expired:${randomUUID()}`, type: 'qa', attemptCount: 1,
      firstAttemptAt: new Date(Date.now() - 7_200_000), updatedAt: new Date(Date.now() - 7_200_000),
    });
    await dataSource.getRepository(RateLimit).save(expired);
    const tasks = new TasksService(
      dataSource.getRepository(BannedIP), dataSource.getRepository(ShareAudit), dataSource.getRepository(RateLimit),
      dataSource.getRepository(AuditLog), dataSource.getRepository(JwtRevokedToken), fileRepo, { add: jest.fn() } as any,
    );
    await tasks.cleanupExpiredRateLimits();
    expect(await dataSource.getRepository(RateLimit).findOneBy({ key: expired.key })).toBeNull();
  });

  it('周报、目录深度、行为基线和分钟百分位聚合可在真实 SQLite 执行', async () => {
    const { User } = require('../common/entities/user.entity') as typeof import('../common/entities/user.entity');
    const { File } = require('../common/entities/file.entity') as typeof import('../common/entities/file.entity');
    const { Folder } = require('../common/entities/folder.entity') as typeof import('../common/entities/folder.entity');
    const { AccessLog } = require('../common/entities/access-log.entity') as typeof import('../common/entities/access-log.entity');
    const { FolderService } = require('../folder/folder.service') as typeof import('../folder/folder.service');
    const { BehaviorAnalyzer } = require('../security/behavior-analyzer.service') as typeof import('../security/behavior-analyzer.service');
    const { AlertEvaluationProcessor, WeeklyReportProcessor } = require('../jobs/other.processors') as typeof import('../jobs/other.processors');
    const { MetricsAggregationProcessor } = require('../jobs/metrics-aggregation.processor') as typeof import('../jobs/metrics-aggregation.processor');

    await dataSource.query(`CREATE TABLE IF NOT EXISTS "access_log_metrics_1min" (
      "windowTime" datetime PRIMARY KEY, "totalRequests" integer NOT NULL, "qpsAvg" real NOT NULL,
      "error5xxCount" integer NOT NULL, "error4xxCount" integer NOT NULL, "totalBandwidth" bigint NOT NULL,
      "p95Duration" real NOT NULL, "uniqueIps" integer NOT NULL)`);
    await dataSource.query(`CREATE TABLE IF NOT EXISTS "baseline_stats" (
      "metricName" varchar NOT NULL, "hourBucket" integer NOT NULL, "dayOfWeek" integer NOT NULL,
      "mean" real NOT NULL, "stddev" real NOT NULL, "sampleCount" integer NOT NULL, "updatedAt" datetime NOT NULL,
      UNIQUE ("metricName", "hourBucket", "dayOfWeek"))`);

    const userRepo = dataSource.getRepository(User);
    const owner = await userRepo.save(userRepo.create({ email: `dialect-${randomUUID()}@example.com`, password: 'hash' }));
    const folderRepo = dataSource.getTreeRepository(Folder);
    const audit = { log: jest.fn(), logAwait: jest.fn() } as any;
    const namespace = {
      acquire: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
      releaseMany: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
      reactivateMany: jest.fn(async () => undefined),
      isNameTaken: jest.fn(async () => false),
    } as any;
    const folderService = new FolderService(folderRepo, dataSource.getRepository(File), audit, namespace);
    const root = await folderService.createFolder(owner.id, { name: `root-${randomUUID()}` });
    const child = await folderService.createFolder(owner.id, { name: `child-${randomUUID()}`, parentId: root.id });
    expect(await (folderService as any).getSubtreeHeightInManager(dataSource.manager, root.id)).toBe(1);
    expect(child.parentId).toBe(root.id);

    const accessLogRepo = dataSource.getRepository(AccessLog);
    const windowTime = new Date();
    windowTime.setUTCSeconds(0, 0);
    const sourceTime = new Date(windowTime.getTime() - 30_000);
    await accessLogRepo.save([10, 20, 30, 40].map((duration, index) => accessLogRepo.create({
      ip: `203.0.113.${index + 1}`, method: 'GET', path: '/aggregate', statusCode: index === 3 ? 500 : 200,
      responseSize: 100, duration, userAgent: index === 0 ? null : 'qa', referer: null, userId: owner.id, createdAt: sourceTime,
    })));
    const jobWindowTime = new Date(windowTime.getTime() + 60_000).toISOString();
    await new MetricsAggregationProcessor(accessLogRepo).aggregate1Min({ data: { windowTime: jobWindowTime } } as any);
    const [metric] = await dataSource.query(
      'SELECT *, typeof("windowTime") AS "windowTimeType" FROM "access_log_metrics_1min" WHERE "windowTime" = ?',
      [windowTime.toISOString().replace('T', ' ').replace('Z', '')],
    );
    expect(metric.windowTime).toBe(windowTime.toISOString().replace('T', ' ').replace('Z', ''));
    expect(metric.windowTimeType).toBe('text');
    expect(Number(metric.p95Duration)).toBeCloseTo(38.5);

    const alertEngine = { evaluateAndCreateAlerts: jest.fn().mockResolvedValue([]) } as any;
    const alertGateway = { broadcastAlert: jest.fn() } as any;
    await new AlertEvaluationProcessor(dataSource, alertEngine, alertGateway)
      .evaluateAlerts({ data: { windowTime: jobWindowTime } } as any);
    expect(alertEngine.evaluateAndCreateAlerts).toHaveBeenCalledWith(expect.objectContaining({
      totalRequests: 4,
      error5xxCount: 1,
    }));

    const analyzer = new BehaviorAnalyzer(dataSource, { get: jest.fn().mockImplementation((_key: string, fallback: string) => fallback) } as any);
    await analyzer.calculateBaselines();
    expect(Number((await dataSource.query('SELECT COUNT(*) AS count FROM "baseline_stats"'))[0].count)).toBeGreaterThan(0);
    await expect(analyzer.detectAnomalies()).resolves.toEqual(expect.any(Array));
    await expect(new WeeklyReportProcessor(dataSource).generateWeeklyReport({} as any)).resolves.toBeUndefined();
  });

  it('真实文件锁冲突会有限重试：短锁后成功，持续锁最终抛出', async () => {
    const { createDatabaseOptions } = require('./database.config') as typeof import('./database.config');
    const { databaseQuery } = require('./database-types') as typeof import('./database-types');
    secondDataSource = new DataSource(createDatabaseOptions({
      ...process.env, DB_TYPE: 'sqlite', DB_DATABASE: DB_PATH, DB_MIGRATIONS_RUN: 'false', DB_SQLITE_BUSY_TIMEOUT_MS: '1',
    }));
    await secondDataSource.initialize();

    await dataSource.query('BEGIN IMMEDIATE');
    const release = new Promise<void>((resolve) => setTimeout(async () => {
      await dataSource.query('COMMIT');
      resolve();
    }, 20));
    await expect(databaseQuery(secondDataSource, 'INSERT INTO system_configs (id, "key", value, "updatedAt") VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
      [randomUUID(), `busy-ok-${randomUUID()}`, '1'], 'sqlite', 3)).resolves.toBeDefined();
    await release;

    await dataSource.query('BEGIN IMMEDIATE');
    const startedAt = Date.now();
    await expect(databaseQuery(secondDataSource, 'INSERT INTO system_configs (id, "key", value, "updatedAt") VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
      [randomUUID(), `busy-fail-${randomUUID()}`, '1'], 'sqlite', 2)).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(70);
    await dataSource.query('ROLLBACK');
  });

  it('主群锚点接管用「删旧行 + 重新插入」的唯一键 CAS：并发接管只有一个赢家', async () => {
    const anchorModule = require('../common/entities/telegram-main-chat-anchor.entity') as typeof import('../common/entities/telegram-main-chat-anchor.entity');
    const { TelegramMainChatAnchor } = anchorModule;
    const repo = dataSource.getRepository(TelegramMainChatAnchor);
    const ownerId = randomUUID();
    const reserve = () => repo.insert(repo.create({
      ownerType: 'file',
      ownerId,
      anchorChatId: '-100999',
      anchorMessageId: null,
      plantedByAccountId: null,
      sourceChatId: '-100555',
      sourceMessageId: '3',
      status: 'pending',
      lastError: null,
      plantedAt: new Date(),
    }));

    // 首次预留：唯一键保证只有一行
    await reserve();
    const [reserved] = await repo.find({ where: { ownerType: 'file', ownerId } });
    expect(reserved.id).toEqual(expect.any(String));

    // 接管者 A：删旧行（条件带 status）→ 重新插入成功，拿到**新的**行 id（UuidSubscriber）
    await repo.delete({ id: reserved.id, status: 'pending' });
    await reserve();
    const [takenOver] = await repo.find({ where: { ownerType: 'file', ownerId } });
    expect(takenOver.id).not.toBe(reserved.id);

    // 接管者 B：拿着**过期**的行 id 删（匹配不到）→ 插入撞唯一键：本调用必须被挡住
    await repo.delete({ id: reserved.id, status: 'pending' });
    await expect(reserve()).rejects.toThrow(/UNIQUE|constraint/i);
    expect(await repo.count({ where: { ownerType: 'file', ownerId } })).toBe(1);

    // 行已收口为 ready 时，带 status='pending' 的删除匹配不到（绝不误删可用锚点）
    await repo.update({ ownerType: 'file', ownerId }, { status: 'ready', anchorMessageId: '777' });
    await repo.delete({ id: takenOver.id, status: 'pending' });
    expect(await repo.count({ where: { ownerType: 'file', ownerId } })).toBe(1);

    // 失败收口带 `status: Not('ready')`：已成功的锚点不会被更早那次超时失败改写成 failed
    const { Not } = require('typeorm') as typeof import('typeorm');
    await repo.update({ id: takenOver.id, status: Not('ready') }, { status: 'failed', lastError: 'stale timeout' });
    expect(await repo.findOneByOrFail({ ownerType: 'file', ownerId })).toMatchObject({
      status: 'ready',
      anchorMessageId: '777',
      lastError: null,
    });

    // 反过来，正常失败路径（行是 pending）必须仍能写入失败状态与原因
    await repo.update({ id: takenOver.id }, { status: 'pending', anchorMessageId: null });
    await repo.update({ id: takenOver.id, status: Not('ready') }, { status: 'failed', lastError: 'boom' });
    expect(await repo.findOneByOrFail({ ownerType: 'file', ownerId })).toMatchObject({
      status: 'failed',
      lastError: 'boom',
    });
  });
});
