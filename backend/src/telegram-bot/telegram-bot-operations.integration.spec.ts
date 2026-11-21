import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe, type ExecutionContext } from '@nestjs/common';
import { Readable } from 'node:stream';
import { DataSource } from 'typeorm';
import type { Request } from 'express';
import type { TelegramBotOperationsService } from './telegram-bot-operations.service';
import type { TelegramBotInboundQueueService } from './telegram-bot-inbound-queue.service';
import type { TelegramBotGrantService } from './telegram-bot-grant.service';
import type { TelegramBotConfigService } from './telegram-bot-config.service';
import { BanTelegramUserDto, BotGrantsQuery, BotOperationsPage, BotOperationsUserParams, BotQueueQuery } from './telegram-bot-operations.dto';

const dialects = ['sqlite', ...(process.env.PG_API_KEY_IT === '1' ? ['postgres'] : [])];

describe.each(dialects)('Telegram Bot 管理与审计 / %s', dialect => {
  const previousDialect = process.env.DB_TYPE;
  const database = 'tgtc_bot_operations_' + randomUUID().replaceAll('-', '');
  let admin: DataSource | undefined;
  let db: DataSource;
  let queue: TelegramBotInboundQueueService;
  let ops: TelegramBotOperationsService;
  let grants: TelegramBotGrantService;
  let quotaDate: string;
  let messageId = 0;
  const operator = randomUUID();
  const config = {
    getConfig: async () => ({ dailyLimit: 10, quotaTimezone: 'UTC' }),
    resolveSiteOriginAsync: async () => 'https://fixture.invalid',
  } as unknown as TelegramBotConfigService;

  beforeAll(async () => {
    process.env.DB_TYPE = dialect;
    jest.resetModules();
    const { createDatabaseOptions } = require('../database/database.config') as typeof import('../database/database.config');
    const options = createDatabaseOptions({ ...process.env, DB_TYPE: dialect, DB_DATABASE: dialect === 'sqlite' ? ':memory:' : database,
      DB_MIGRATIONS_RUN: 'false', NODE_ENV: 'test' });
    if (options.type === 'postgres') {
      admin = await new DataSource({ ...options, database: process.env.DB_DATABASE || 'file_distribution_ci' }).initialize();
      await admin.query('CREATE DATABASE "' + database + '"');
    }
    db = await new DataSource(options).initialize();
    await db.runMigrations();
    const { TelegramBotQuotaService: Quota } = require('./telegram-bot-quota.service') as typeof import('./telegram-bot-quota.service');
    const { TelegramBotInboundQueueService: Queue } = require('./telegram-bot-inbound-queue.service') as typeof import('./telegram-bot-inbound-queue.service');
    const { TelegramBotGrantService: Grants } = require('./telegram-bot-grant.service') as typeof import('./telegram-bot-grant.service');
    const { TelegramBotTokenCryptoService: Crypto } = require('./telegram-bot-token-crypto.service') as typeof import('./telegram-bot-token-crypto.service');
    const { TelegramBotOperationsService: Operations } = require('./telegram-bot-operations.service') as typeof import('./telegram-bot-operations.service');
    const quota = new Quota(db.getRepository('TelegramBotDailyUsage'), db.getRepository('TelegramBotWhitelist'), db);
    quotaDate = quota.getBusinessDate('UTC');
    queue = new Queue(db);
    grants = new Grants(db.getRepository('TelegramBotFileGrant'), new Crypto(new ConfigService({ TELEGRAM_BOT_ENCRYPTION_KEY: '12'.repeat(32) })));
    ops = new Operations(db, queue, grants, config, quota);
  }, 30000);

  afterAll(async () => {
    if (queue) await queue.onApplicationShutdown();
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query('DROP DATABASE "' + database + '" WITH (FORCE)');
      await admin.destroy();
    }
    if (previousDialect === undefined) delete process.env.DB_TYPE;
    else process.env.DB_TYPE = previousDialect;
  });

  async function enqueue(receiverBotId: string, telegramUserId: string) {
    const result = await queue.enqueue({
      receiverBotId, telegramUserId, chatId: telegramUserId, messageId: String(++messageId), dailyLimit: 10, usageDate: quotaDate,
      sourceAccountId: null, telegramUsername: 'member', telegramDisplayName: null, fileName: 'file.txt', fileSize: '12',
      telegramFileId: 'private-telegram-file-id', fileUniqueId: null, mimeType: 'text/plain',
    });
    if (result.status !== 'queued') throw new Error(result.status);
    return result.task;
  }

  function issue(receiverBotId: string, telegramUserId: string, storageBackend: string, ttlHours = 24) {
    return grants.issue({ receiverBotId, telegramUserId, username: null, displayName: null, chatId: telegramUserId,
      messageId: String(++messageId), telegramFileId: 'private-telegram-file-id',
      storageBackend, storageAccountId: 'fixture-account', storageObjectRef: 'private-object-key', fileName: 'fixture', fileSize: '12', mimeType: null }, ttlHours);
  }

  it('同 Bot 跨用户正确计算等待位置，幂等取消与配额退款、管理审计在同一条事务链', async () => {
    const first = await enqueue('1001', '101');
    const middle = await enqueue('1001', '102');
    const last = await enqueue('1001', '101');
    await queue.claimNext('1001');
    const list = await ops.listQueue(Object.assign(new BotQueueQuery(), { telegramUserId: '101' }));
    expect(list.rows.map(row => [row.id, row.status, row.position])).toEqual([[last.id, 'queued', 3], [first.id, 'running', 1]]);
    expect(list.rows[0]).not.toHaveProperty('telegramFileId');
    await expect(ops.cancel(middle.id, operator)).resolves.toEqual({ changed: true });
    await expect(ops.cancel(middle.id, operator)).resolves.toEqual({ changed: false });
    const filtered = await ops.listQueue(Object.assign(new BotQueueQuery(), { receiverBotId: '1001', status: 'queued', pageSize: 1 }));
    expect(filtered).toMatchObject({ total: 1, rows: [{ id: last.id, position: 2 }] });
    await expect(ops.userDetails('102')).resolves.toMatchObject({ quota: { used: 0 }, uploads: { total: 1, byStatus: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 1 } } });
    const audit = await ops.userAudit('102', new BotOperationsPage());
    expect(audit).toMatchObject({ total: 1, rows: [{ userId: operator, action: 'telegram_bot_task_cancelled', resourceId: middle.id }] });
    await expect(ops.cancel(randomUUID(), operator)).rejects.toMatchObject({ status: 404 });
  });

  it('按状态、用户与时间筛选历史，单条显式回放和撤销均受审计并隐藏秘密', async () => {
    const current = await issue('2001', '201', 'gdrive');
    const expired = await issue('2001', '201', 'telegram', -1);
    const other = await issue('2002', '201', 'telegram');
    const list = await ops.listGrants(Object.assign(new BotGrantsQuery(), { receiverBotId: '2001', telegramUserId: '201',
      from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 86400000).toISOString() }));
    expect(list).toMatchObject({ total: 1, rows: [{ id: current.grant.id, status: 'active', fileSize: '12' }] });
    const boundary = new Date('2025-05-01T09:00:00.000Z');
    const createdAt = dialect === 'sqlite' ? () => "'2025-05-01 09:00:00'" : boundary;
    await db.getRepository('TelegramBotFileGrant').update({ id: current.grant.id }, { createdAt });
    const exact = await ops.listGrants(Object.assign(new BotGrantsQuery(), { telegramUserId: '201',
      from: boundary.toISOString(), to: boundary.toISOString() }));
    expect(exact.rows.map(row => row.id)).toEqual([current.grant.id]);
    for (const key of ['tokenCipher', 'tokenHash', 'storageObjectRef', 'telegramFileId']) expect(list.rows[0]).not.toHaveProperty(key);
    await expect(ops.reveal(current.grant.id, operator, {} as Request)).resolves.toEqual({ url: 'https://fixture.invalid/api/bot-dl/' + current.token });
    await expect(ops.revoke(current.grant.id, operator)).resolves.toEqual({ changed: true });
    await expect(ops.revoke(current.grant.id, operator)).resolves.toEqual({ changed: false });
    await expect(ops.revoke(expired.grant.id, operator)).resolves.toEqual({ changed: false });
    await expect(ops.reveal(current.grant.id, operator, {} as Request)).rejects.toMatchObject({ status: 410 });
    await expect(ops.reveal(expired.grant.id, operator, {} as Request)).rejects.toMatchObject({ status: 410 });
    const revoked = await ops.listGrants(Object.assign(new BotGrantsQuery(), { telegramUserId: '201', status: 'revoked' }));
    expect(revoked).toMatchObject({ total: 1, rows: [{ id: current.grant.id, revokedBy: operator }] });
    expect((await ops.listGrants(Object.assign(new BotGrantsQuery(), { telegramUserId: '201' }))).rows[0].id).toBe(other.grant.id);
    const trail = await ops.userAudit('201', new BotOperationsPage());
    expect(trail.total).toBe(2);
    expect(JSON.stringify(trail)).not.toContain(current.token);
    await expect(ops.listGrants(Object.assign(new BotGrantsQuery(), { from: '2026-W01' }))).rejects.toMatchObject({ status: 400 });
    await expect(ops.listGrants(Object.assign(new BotGrantsQuery(), { from: '2026-05-02', to: '2026-05-01' }))).rejects.toMatchObject({ status: 400 });
  });

  it('跨 Bot 封禁同时处理运行中/等待、旧无 Bot ID 的有效链接及 Google 授权，并保留其他用户', async () => {
    await enqueue('3001', '301');
    await queue.claimNext('3001');
    await enqueue('3002', '301');
    await enqueue('3002', '302');
    const legacy = await issue('3001', '301', 'telegram');
    await db.getRepository('TelegramBotFileGrant').update({ id: legacy.grant.id }, { receiverBotId: null });
    await issue('3002', '301', 'gdrive');
    await issue('3002', '301', 'gdrive', -1);
    const unaffected = await issue('3002', '302', 'gdrive');
    await db.getRepository('AccessLog').save({ ip: '127.0.0.1', method: 'GET', path: '/api/bot-dl/[redacted]', statusCode: 200,
      botTelegramUserId: '301', botGrantId: legacy.grant.id, responseSize: 60, responseBodyBytes: '42' });
    const result = await ops.ban('301', 'abuse report', operator);
    expect(result).toMatchObject({ ban: { reason: 'abuse report', bannedBy: operator, telegramUserId: '301', bannedAt: expect.any(Date) }, cancelledTasks: 2, revokedGrants: 2 });
    const again = await ops.ban('301', 'second reason', randomUUID());
    expect(again).toMatchObject({ ban: result.ban, cancelledTasks: 0, revokedGrants: 0 });
    expect((await ops.listQueue(Object.assign(new BotQueueQuery(), { telegramUserId: '301', status: 'cancelled' }))).total).toBe(2);
    const details = await ops.userDetails('301');
    expect(details).toMatchObject({ ban: result.ban, quota: { used: 0, limit: 10 }, grants: { total: 3, active: 0 }, downloads: { requests: 1, bytes: '42' } });
    await expect(enqueue('3003', '301')).rejects.toThrow('banned');
    await expect(ops.userDetails('302')).resolves.toMatchObject({ ban: null, quota: { used: 1 }, grants: { total: 1, active: 1 } });
    expect((await grants.findByToken(unaffected.token))?.revokedAt).toBeNull();
    expect(await ops.userAudit('301', new BotOperationsPage())).toMatchObject({ total: 1, rows: [{ action: 'telegram_bot_user_banned',
      userId: operator, metadata: { cancelledTasks: 2, revokedGrants: 2, reason: 'abuse report' } }] });
  });

  it('管理 HTTP 权限与分页先校验；确认撤销、封禁后，公开下载立即返回 404', async () => {
    const { Test } = require('@nestjs/testing') as typeof import('@nestjs/testing');
    const { UnauthorizedException, ValidationPipe: HttpValidationPipe } = require('@nestjs/common') as typeof import('@nestjs/common');
    const { JwtAuthGuard } = require('../common/guards/jwt-auth.guard');
    const { TelegramBotPublicController } = require('./telegram-bot-public.controller');
    const { TelegramBotOperationsController } = require('./telegram-bot-operations.controller');
    const { TelegramBotOperationsService } = require('./telegram-bot-operations.service');
    const { TelegramBotGrantService } = require('./telegram-bot-grant.service');
    const { TelegramService } = require('../telegram/telegram.service');
    const { FileCacheService } = require('../file/file-cache.service');
    const { RateLimitService } = require('../common/services/rate-limit.service');
    const { StreamResponderService } = require('../common/services/stream-responder.service');
    const { AuditService } = require('../common/services/audit.service');
    const { StorageRouterService } = require('../storage/storage-router.service');
    const upstream = jest.fn(async () => ({ stream: Readable.from(Buffer.from('fixture-data')), size: 12 }));
    const module = await Test.createTestingModule({
      controllers: [TelegramBotOperationsController, TelegramBotPublicController],
      providers: [
        { provide: TelegramBotOperationsService, useValue: ops }, { provide: TelegramBotGrantService, useValue: grants },
        { provide: TelegramService, useValue: {} }, { provide: FileCacheService, useValue: {} },
        { provide: RateLimitService, useValue: { checkAndIncrement: async () => ({ allowed: true }) } },
        StreamResponderService, { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: StorageRouterService, useValue: { openDownloadStream: upstream } },
      ],
    }).overrideGuard(JwtAuthGuard).useValue({
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest();
        if (!req.headers.authorization) throw new UnauthorizedException();
        req.user = { id: operator, role: req.headers.authorization === 'Bearer fixture-admin' ? 'super_admin' : 'user' };
        return true;
      },
    }).compile();
    const app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new HttpValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    try {
      await app.listen(0, '127.0.0.1');
      const origin = await app.getUrl();
      const manage = (path: string, init: RequestInit = {}) => fetch(origin + '/api/admin/bot-operations' + path, {
        ...init, headers: { authorization: 'Bearer fixture-admin', 'content-type': 'application/json', ...init.headers },
      });
      expect((await fetch(origin + '/api/admin/bot-operations/grants')).status).toBe(401);
      expect((await manage('/grants', { headers: { authorization: 'Bearer fixture-member' } })).status).toBe(403);
      expect((await manage('/queue?pageSize=101')).status).toBe(400);
      expect((await manage('/users/not-a-number')).status).toBe(400);
      expect((await manage('/users/501/ban', { method: 'POST', body: JSON.stringify({ reason: '   ' }) })).status).toBe(400);
      const first = await issue('5001', '501', 'gdrive');
      const second = await issue('5002', '501', 'gdrive');
      const unaffected = await issue('5001', '502', 'gdrive');
      const download = (token: string) => fetch(origin + '/api/bot-dl/' + token);
      const response = await download(first.token);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('fixture-data');
      const replay = await manage('/grants/' + first.grant.id + '/link');
      expect(replay.headers.get('cache-control')).toContain('no-store');
      expect(await replay.json()).toMatchObject({ url: 'https://fixture.invalid/api/bot-dl/' + first.token });
      expect((await manage('/grants/' + first.grant.id + '/revoke', { method: 'POST' })).status).toBe(200);
      expect((await download(first.token)).status).toBe(404);
      expect((await manage('/users/501/ban', { method: 'POST', body: JSON.stringify({ reason: 'incident' }) })).status).toBe(200);
      expect((await download(second.token)).status).toBe(404);
      expect(await (await download(unaffected.token)).text()).toBe('fixture-data');
      expect(upstream).toHaveBeenCalledTimes(2);
      const audit = await manage('/users/501/audit?page=2&pageSize=1');
      expect(await audit.json()).toMatchObject({ page: 2, pageSize: 1, total: 3, rows: [expect.objectContaining({ userId: operator })] });
      const future = await manage('/users/501/audit?from=2099-01-01');
      expect(await future.json()).toMatchObject({ rows: [], total: 0 });
    } finally {
      await app.close();
    }
  });

  it('审计表无法写入时回滚封禁、任务取消、配额和直链撤销', async () => {
    const task = await enqueue('4001', '401');
    const issued = await issue('4001', '401', 'gdrive');
    // Renaming this table is confined to the per-suite disposable database.
    await db.query('ALTER TABLE audit_logs RENAME TO temporarily_unavailable_audit');
    try {
      await expect(ops.cancel(task.id, operator)).rejects.toThrow();
      await expect(ops.revoke(issued.grant.id, operator)).rejects.toThrow();
      await expect(ops.ban('401', 'test rollback', operator)).rejects.toThrow();
    } finally {
      await db.query('ALTER TABLE temporarily_unavailable_audit RENAME TO audit_logs');
    }
    await expect(ops.userDetails('401')).resolves.toMatchObject({ ban: null, quota: { used: 1 }, grants: { active: 1 } });
    expect((await ops.listQueue(Object.assign(new BotQueueQuery(), { telegramUserId: '401' }))).rows[0]).toMatchObject({ id: task.id, status: 'queued' });
  });
});

describe('Bot 运维输入校验', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  it('身份证明、时间、状态和分页严格校验，原因必须有文字', async () => {
    for (const [input, type] of [
      [{ telegramUserId: '-123' }, BotOperationsUserParams], [{ status: 'active' }, BotQueueQuery],
      [{ from: 'not-a-date' }, BotGrantsQuery], [{ pageSize: 101 }, BotGrantsQuery], [{ reason: '    ' }, BanTelegramUserDto],
      [{ reason: 'x'.repeat(501) }, BanTelegramUserDto],
    ] as const) await expect(pipe.transform(input, { type: 'query', metatype: type })).rejects.toMatchObject({ status: 400 });
    expect(await pipe.transform({ reason: '  incident  ' }, { type: 'body', metatype: BanTelegramUserDto })).toMatchObject({ reason: 'incident' });
  });
});
