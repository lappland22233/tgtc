import { randomUUID } from 'crypto';
import { rm } from 'fs/promises';
import { join } from 'path';
import { DataSource } from 'typeorm';

const DB_PATH = join(process.cwd(), 'tmp', `sqlite-real-qa-${process.pid}-${Date.now()}.sqlite`);

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
  });

  afterAll(async () => {
    if (secondDataSource?.isInitialized) await secondDataSource.destroy();
    if (dataSource?.isInitialized) await dataSource.destroy();
    await rm(DB_PATH, { force: true });
    if (originalDbType === undefined) delete process.env.DB_TYPE;
    else process.env.DB_TYPE = originalDbType;
    if (originalDatabase === undefined) delete process.env.DB_DATABASE;
    else process.env.DB_DATABASE = originalDatabase;
  });

  it('迁移升级、安全 revert、重放及完整性检查均保留业务数据', async () => {
    const userId = randomUUID();
    await dataSource.query(
      'INSERT INTO users (id, email, password, role, "isBanned", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [userId, 'migration-qa@example.com', 'hash', 'user'],
    );

    const appliedBefore = await dataSource.query('SELECT name FROM migrations ORDER BY timestamp');
    expect(appliedBefore.map((row: { name: string }) => row.name)).toEqual([
      'SqliteEntitySchema1700000000000',
      'SqliteSchemaAlignment1800000000000',
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
    const folderService = new FolderService(dataSource.getTreeRepository(Folder), dataSource.getRepository(File), audit);
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
      {} as any, {} as any, audit, {} as any, {} as any,
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
    const { WeeklyReportProcessor } = require('../jobs/other.processors') as typeof import('../jobs/other.processors');
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
    const folderService = new FolderService(folderRepo, dataSource.getRepository(File), audit);
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
    await new MetricsAggregationProcessor(accessLogRepo).aggregate1Min({ data: { windowTime: new Date(windowTime.getTime() + 60_000).toISOString() } } as any);
    const [metric] = await dataSource.query('SELECT * FROM "access_log_metrics_1min" ORDER BY "windowTime" DESC LIMIT 1');
    expect(Number(metric.p95Duration)).toBeCloseTo(38.5);

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
});
