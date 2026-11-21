import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { DataSource } from 'typeorm';

// 同一组业务回归分别运行于真实 SQLite 和隔离 PostgreSQL 数据库，禁止用 ORM 链式 mock。
const dialects = ['sqlite', ...(process.env.PG_API_KEY_IT === '1' ? ['postgres'] : [])];

describe.each(dialects)('security review regressions / %s', (dialect) => {
  let db: DataSource;
  let admin: DataSource | undefined;
  const database = `tgtc_security_${process.pid}_${Date.now()}`;
  const originalType = process.env.DB_TYPE;
  const originalSecret = process.env.CODE_HMAC_SECRET;
  const secret = 'security-review-test-key-with-at-least-32-characters';
  let models: any;
  let services: any;
  let owner: any;
  let file: any;
  let sessions: any;
  let shares: any;
  let auth: any;
  let passwords: any;
  let access: any;
  let jwt: any;
  let strategy: any;
  const audit = { log: jest.fn(), logAwait: jest.fn() };
  const cache = { get: jest.fn(async (_key: string, fallback: string) => fallback) };
  const gateways: any[] = [];

  beforeAll(async () => {
    process.env.DB_TYPE = dialect;
    process.env.CODE_HMAC_SECRET = secret;
    jest.resetModules();
    models = Object.assign({}, ...[
      'user', 'file', 'folder', 'verification-code', 'rate-limit', 'jwt-revoked-token',
      'share-link', 'share-preview-session', 'banned-ip', 'telegram-file-copy',
    ].map((name) => require(`../common/entities/${name}.entity`)));
    services = {
      ...require('../share/share-preview-session.service'), ...require('../share/share.service'),
      ...require('../share/share-password.service'), ...require('../share/share-folder-browse.service'),
      ...require('../auth/auth.service'), ...require('../auth/jwt.strategy'),
      ...require('../alert/alert.gateway'), ...require('../folder/folder.service'),
      ...require('../file/file.service'), ...require('../file/file-access-control.service'),
      ...require('../common/services/rate-limit.service'), ...require('../common/services/directory-namespace.service'),
    };
    const { createDatabaseOptions } = require('./database.config');
    const options = createDatabaseOptions({ ...process.env, DB_TYPE: dialect,
      DB_DATABASE: dialect === 'sqlite' ? ':memory:' : database, DB_MIGRATIONS_RUN: 'false', NODE_ENV: 'test' });
    if (dialect === 'postgres') {
      admin = new DataSource({ ...options, database: process.env.DB_DATABASE || 'file_distribution_ci' });
      await admin.initialize();
      await admin.query(`CREATE DATABASE "${database}"`);
    }
    db = new DataSource(options);
    await db.initialize();
    await db.runMigrations();
  }, 30000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      await admin.destroy();
    }
    if (originalType === undefined) delete process.env.DB_TYPE; else process.env.DB_TYPE = originalType;
    if (originalSecret === undefined) delete process.env.CODE_HMAC_SECRET; else process.env.CODE_HMAC_SECRET = originalSecret;
  });

  beforeEach(async () => {
    const repo = (entity: any) => db.getRepository(entity);
    owner = await repo(models.User).save({ email: `${randomUUID()}@example.invalid`, password: 'hash',
      role: 'super_admin', emailVerified: true });
    // 超管有唯一索引；用例结束后删除本轮用户前先降为普通角色。
    file = await repo(models.File).save({ filename: 'file-id-b', originalName: randomUUID(),
      telegramFileId: 'file-id-b', mimeType: 'video/mp4', size: 10, uploaderId: owner.id,
      telegramSourceAccountId: 'bot-b', telegramFileUniqueId: 'unique-b', telegramChatId: '-100123', telegramMessageId: '42' });
    const rates = new services.RateLimitService(repo(models.RateLimit));
    const { JwtService } = require('@nestjs/jwt');
    const { ConfigService } = require('@nestjs/config');
    jwt = new JwtService({ secret, signOptions: { expiresIn: '1h' } });
    const config = new ConfigService({ JWT_SECRET: secret });
    auth = new services.AuthService(repo(models.User), repo(models.VerificationCode), repo(models.BannedIP),
      repo(models.JwtRevokedToken), db, cache, jwt, {}, rates, audit, {});
    strategy = new services.JwtStrategy(config, auth, cache);
    sessions = new services.SharePreviewSessionService(repo(models.SharePreviewSession), db);
    passwords = new services.SharePasswordService(repo(models.BannedIP), rates, cache, config, jwt);
    access = new services.FileAccessControlService(repo(models.File), repo(models.BannedIP), audit, cache, rates);
    shares = new services.ShareService(repo(models.ShareLink), repo(models.File), repo(models.Folder), audit,
      passwords, { getStreamForShareDownload: jest.fn(async () => ({ stream: Readable.from('data') })),
        getSharePreviewStreamWithRange: jest.fn(async () => ({ stream: Readable.from('data') })) }, config, sessions,
      new services.ShareFolderBrowseService(repo(models.File), repo(models.Folder), audit));
  });

  afterEach(async () => {
    for (const gateway of gateways.splice(0)) gateway.stopReauthLoop();
    jest.restoreAllMocks();
    if (owner && db?.isInitialized) await db.getRepository(models.User).update(owner.id, { role: 'user' });
  });

  const makeLink = async (maxAccessCount = 1) => db.getRepository(models.ShareLink).save({
    token: randomUUID(), targetType: 'file', targetId: file.id, creatorId: owner.id, maxAccessCount,
  });
  const count = async (link: any) => (await db.getRepository(models.ShareLink).findOneByOrFail({ id: link.id })).currentAccessCount;

  if (dialect === 'postgres') {
    it('publishes the compiled migration only when all nonempty business tables are covered', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tgtc-migrate-'));
      const target = join(dir, 'target.sqlite');
      const ruleId = randomUUID();
      const { TelegramMirrorRule } = require('../common/entities/telegram-mirror-rule.entity');
      await db.getRepository(TelegramMirrorRule).save({
        id: ruleId, name: 'migration-audit', enabled: true, sourceChatId: '-11', targetChatId: '-12',
        includeBotInboundFiles: false,
      });
      const env = { ...process.env, DB_DATABASE: database, MIGRATION_TARGET: target };
      const run = () => promisify(execFile)(process.execPath, ['dist-migrator/build-data-migrator.js'], { env });
      try {
        await run();
        const report = JSON.parse(await readFile(target + '.migration-report.json', 'utf8'));
        expect(report.validation.data.tables.telegram_mirror_rules).toMatchObject({ source: 1, copied: 1, target: 1 });
        const startup = await promisify(execFile)(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', `
          const {DataSource} = require('typeorm');
          const {createDatabaseOptions} = require('./src/database/database.config');
          (async () => {
            const db = await new DataSource(createDatabaseOptions()).initialize();
            console.log(JSON.stringify({pending: await db.showMigrations(),
              rows: await db.query('SELECT id, "includeBotInboundFiles" AS inbound FROM telegram_mirror_rules')}));
            await db.destroy();
          })().catch(e => {console.error(e); process.exitCode=1});
        `], { env: { ...env, DB_TYPE: 'sqlite', DB_DATABASE: target, DB_MIGRATIONS_RUN: 'true' } });
        expect(JSON.parse(startup.stdout)).toEqual({ pending: false, rows: [{ id: ruleId, inbound: 0 }] });
        const original = await readFile(target);
        await db.query('CREATE TABLE migration_future_business (id integer primary key)');
        await db.query('INSERT INTO migration_future_business VALUES (1)');
        await expect(run()).rejects.toThrow();
        expect((await readFile(target)).equals(original)).toBe(true);
      } finally {
        await db.query('DROP TABLE IF EXISTS migration_future_business');
        await rm(dir, { recursive: true, force: true });
      }
    }, 60000);
  }

  it('checks password lock state without mutating its counter', async () => {
    const token = randomUUID();
    expect(await passwords.checkPasswordAttemptAllowed('127.0.0.1', token)).toBe(true);
    const rates = db.getRepository(models.RateLimit);
    expect(await rates.countBy({ key: `share-password:token-lock:${token}` })).toBe(0);
    await new services.RateLimitService(rates).checkAndIncrement(
      `share-password:token-lock:${token}`, 'share_password_token_lock', 1, 60000, 60000,
    );
    expect(await passwords.checkPasswordAttemptAllowed(null, token)).toBe(false);
  });

  it('prunes only expired preview sessions and reports the bounded delete count', async () => {
    const link = await makeLink(-1);
    const repo = db.getRepository(models.SharePreviewSession);
    for (const visitor of ['expired-1', 'expired-2', 'live']) {
      await sessions.consumePreviewAccess(link, file.id, visitor);
    }
    const rows = await repo.findBy({ shareLinkId: link.id });
    await repo.update(rows[0].id, { expiresAt: new Date(0) });
    await repo.update(rows[1].id, { expiresAt: new Date(0) });
    expect(await sessions.pruneExpired(1)).toBe(1);
    expect(await sessions.pruneExpired(1)).toBe(1);
    expect(await sessions.pruneExpired(1)).toBe(0);
    expect(await repo.findOneBy({ id: rows[2].id })).toBeTruthy();
  });

  it.each(['restore', 'delete'])('respects the first commit when %s wins the deletion race', async (first) => {
    const repo = db.getRepository(models.File);
    await repo.update(file.id, { isDeleted: true, deleteRequestedAt: new Date(Date.now() - 120000),
      deleteScheduledAt: new Date(Date.now() + 3600000), gdriveCacheObjectRef: 'cached' });
    const files = Object.assign(Object.create(services.FileService.prototype), {
      fileRepository: repo, namespaceService: new services.DirectoryNamespaceService(db), auditService: audit,
      fileCacheService: { invalidate: jest.fn() }, deleteLocalThumbnail: jest.fn(),
      cleanupGDriveCacheObject: jest.fn(), cleanupNonTelegramObject: jest.fn(),
    });
    const transaction = repo.manager.transaction.bind(repo.manager);
    // Run the competing request just before the first request can lock the row.
    const loser = first === 'restore' ? 'forceDelete' : 'restoreDelete';
    const winner = first === 'restore' ? 'restoreDelete' : 'forceDelete';
    jest.spyOn(repo.manager, 'transaction').mockImplementationOnce(async (work: any) => {
      await files[winner](file.id, owner);
      return transaction(work);
    });
    await expect(files[loser](file.id, owner)).rejects.toThrow();
    if (first === 'restore') {
      expect(await repo.findOneBy({ id: file.id })).toMatchObject({ isDeleted: false, gdriveCacheObjectRef: 'cached' });
      expect(files.cleanupGDriveCacheObject).not.toHaveBeenCalled();
    } else {
      expect(await repo.findOneBy({ id: file.id })).toBeNull();
      expect(files.cleanupGDriveCacheObject).toHaveBeenCalledWith(expect.objectContaining({ id: file.id, gdriveCacheObjectRef: 'cached' }));
    }
  });

  it.each(['move', 'rename'])('preserves a cache reference attached while waiting to %s', async (op) => {
    const repo = db.getRepository(models.File);
    const folders = new services.FolderService(db.getTreeRepository(models.Folder), repo, audit,
      new services.DirectoryNamespaceService(db));
    const transaction = repo.manager.transaction.bind(repo.manager);
    jest.spyOn(repo.manager, 'transaction').mockImplementationOnce(async (work: any) => {
      await repo.update(file.id, { gdriveCacheObjectRef: 'new-cache' });
      return transaction(work);
    });
    if (op === 'move') await folders.moveFile(owner.id, file.id, {});
    else await folders.renameFile(owner.id, file.id, { newOriginalName: 'renamed' });
    expect((await repo.findOneByOrFail({ id: file.id })).gdriveCacheObjectRef).toBe('new-cache');
  });

  it('first preview consumes once; last-slot Range and media-ticket reconnect remain usable', async () => {
    const link = await makeLink();
    await shares.getSharePreviewStream(link.token, file.id, undefined, null, undefined, 'visitor');
    await shares.getSharePreviewStream(link.token, file.id, undefined, null, 'bytes=1-2', 'visitor');
    await shares.getSharePreviewStreamForMediaTicket(link.id, file.id, file.uploadVersion, null, 'bytes=2-3', 'visitor');
    expect(await count(link)).toBe(1);
    await expect(shares.getSharePreviewStream(link.token, file.id, undefined, null, undefined, 'other'))
      .rejects.toThrow('次数已耗尽');
    expect(await db.getRepository(models.SharePreviewSession).countBy({ shareLinkId: link.id })).toBe(1);
  });

  it('concurrent same-session requests consume one slot', async () => {
    const link = await makeLink();
    const results = await Promise.all(Array.from({ length: 8 }, () => sessions.consumePreviewAccess(link, file.id, 'same')));
    expect(results.filter((r) => r === 'consumed')).toHaveLength(1);
    expect(results.filter((r) => r === 'idempotent')).toHaveLength(7);
    expect(await count(link)).toBe(1);
  });

  it('concurrent visitors cannot overdraw the final slots or retain uncharged sessions', async () => {
    const link = await makeLink(2);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => sessions.consumePreviewAccess(link, file.id, `v${i}`)));
    expect(results.filter((r) => r === 'consumed')).toHaveLength(2);
    expect(results.filter((r) => r === 'exhausted')).toHaveLength(4);
    expect(await count(link)).toBe(2);
    expect(await db.getRepository(models.SharePreviewSession).countBy({ shareLinkId: link.id })).toBe(2);
  });

  it('expired preview sessions need fresh quota; unlimited shares can renew', async () => {
    const link = await makeLink();
    await sessions.consumePreviewAccess(link, file.id, 'visitor');
    await db.getRepository(models.SharePreviewSession).update({ shareLinkId: link.id }, { expiresAt: new Date(0) });
    expect(await sessions.consumePreviewAccess(link, file.id, 'visitor')).toBe('exhausted');
    await db.getRepository(models.ShareLink).update(link.id, { maxAccessCount: -1 });
    expect(await sessions.consumePreviewAccess(link, file.id, 'visitor')).toBe('consumed');
    expect(await count(link)).toBe(2);
  });

  it.each(['cancelled', 'expired'])('existing sessions cannot bypass a %s share', async (state) => {
    const link = await makeLink();
    await sessions.consumePreviewAccess(link, file.id, 'visitor');
    await db.getRepository(models.ShareLink).update(link.id, state === 'cancelled'
      ? { isDeleted: true } : { expiresIn: 1, expiresStartAt: new Date(0) });
    await expect(shares.getSharePreviewStream(link.token, file.id, undefined, null, 'bytes=1-2', 'visitor'))
      .rejects.toThrow(state === 'cancelled' ? '不存在' : '已过期');
  });

  it('session persistence failure rolls back quota', async () => {
    const link = await makeLink();
    const repoPrototype = Object.getPrototypeOf(db.getRepository(models.SharePreviewSession));
    const originalSave = repoPrototype.save;
    jest.spyOn(repoPrototype, 'save').mockImplementation(function (this: any, ...args: any[]) {
      if (this.metadata.name === 'SharePreviewSession') throw new Error('session write failed');
      return originalSave.apply(this, args);
    });
    await expect(sessions.consumePreviewAccess(link, file.id, 'visitor')).rejects.toThrow('session write failed');
    expect(await count(link)).toBe(0);
    expect(await db.getRepository(models.SharePreviewSession).countBy({ shareLinkId: link.id })).toBe(0);
  });

  it.each(['register', 'reset_password'])('locked %s verification rejects even a correct code without consuming it', async (type) => {
    const code = '654321';
    const row = await db.getRepository(models.VerificationCode).save({ email: owner.email, type,
      code: auth.hashCode(code), expiresAt: new Date(Date.now() + 300000) });
    for (let i = 0; i < 5; i++) await expect(auth.validateVerificationCode(owner.email, '000000', type)).rejects.toThrow();
    await expect(auth.validateVerificationCode(owner.email, code, type)).rejects.toThrow('错误次数过多');
    expect((await db.getRepository(models.VerificationCode).findOneByOrFail({ id: row.id })).isUsed).toBe(false);
    await db.getRepository(models.RateLimit).delete({ key: `code:${owner.email}:${type}` });
    await auth.validateVerificationCode(owner.email, code, type);
    await expect(auth.validateVerificationCode(owner.email, code, type)).rejects.toThrow('无效或已过期');
  });

  it('HTTP and WebSocket both reject a revoked or pre-password-change session', async () => {
    const payload = { sub: owner.id, email: owner.email, role: owner.role, jti: randomUUID(), iat: Math.floor(Date.now() / 1000) };
    const token = jwt.sign(payload);
    await auth.revokeToken(payload.jti, owner.id, new Date(Date.now() + 3600000));
    await expect(strategy.validatePayload(payload)).rejects.toThrow('吊销');
    const gateway = new services.AlertGateway(jwt, strategy, { checkAndIncrement: async () => ({ allowed: true }) });
    gateways.push(gateway);
    const client = { id: 'test', data: {}, handshake: { auth: { token }, headers: {}, address: '192.0.2.1' },
      join: jest.fn(), disconnect: jest.fn() };
    await gateway.handleConnection(client);
    expect(client.join).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalled();
    const freshToken = jwt.sign({ ...payload, jti: randomUUID() });
    await db.getRepository(models.User).update(owner.id, { passwordUpdatedAt: new Date(Date.now() + 1000) });
    client.handshake.auth.token = freshToken;
    client.disconnect.mockClear();
    await gateway.handleConnection(client);
    expect(client.join).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('an established WebSocket rechecks revocation on its lifecycle timer', async () => {
    const payload = { sub: owner.id, email: owner.email, role: owner.role, jti: randomUUID() };
    const gateway = new services.AlertGateway(jwt, strategy, { checkAndIncrement: async () => ({ allowed: true }) });
    gateways.push(gateway);
    let recheck!: () => Promise<void>;
    const originalInterval = global.setInterval;
    jest.spyOn(global, 'setInterval').mockImplementation(((fn: () => Promise<void>, delay: number) => {
      recheck = fn;
      return originalInterval(fn, delay);
    }) as typeof setInterval);
    const client = { id: 'test', data: {}, handshake: { auth: { token: jwt.sign(payload) }, headers: {}, address: '192.0.2.1' },
      join: jest.fn(), disconnect: jest.fn() };
    gateway.server = { of: () => ({ sockets: new Map([['test', client]]) }) };
    await gateway.handleConnection(client);
    expect(client.join).toHaveBeenCalledWith('super-admins');
    await auth.revokeToken(payload.jti, owner.id, new Date(Date.now() + 3600000));
    await recheck();
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('manual unban is respected by both password services and automatic reban reactivates it', async () => {
    const ip = `192.0.2.${Math.floor(Math.random() * 200) + 2}`;
    const row = await db.getRepository(models.BannedIP).save({ ip, isPermanent: true });
    expect((await passwords.isIPBanned(ip)).banned).toBe(true);
    await db.getRepository(models.BannedIP).update(row.id, { unbannedAt: new Date() });
    expect((await passwords.isIPBanned(ip)).banned).toBe(false);
    expect((await access.isIPBanned(ip)).banned).toBe(false);
    for (let i = 0; i < 5; i++) await passwords.recordFailedAttempt(ip);
    expect((await access.isIPBanned(ip)).banned).toBe(true);
    expect((await db.getRepository(models.BannedIP).findOneByOrFail({ id: row.id })).unbannedAt).toBeNull();
  });

  it('copied pooled files retain source identity and per-account ready replicas', async () => {
    await db.getRepository(models.TelegramFileCopy).save({ ownerType: 'file', ownerId: file.id, accountId: 'bot-b',
      telegramFileId: file.telegramFileId, chatId: file.telegramChatId, messageId: file.telegramMessageId, source: 'inbound' });
    const folders = new services.FolderService(db.getTreeRepository(models.Folder), db.getRepository(models.File), audit,
      new services.DirectoryNamespaceService(db));
    const copy = await folders.copyFile(owner.id, file.id, {});
    expect(copy.telegramSourceAccountId).toBe('bot-b');
    expect(copy.telegramFileUniqueId).toBe('unique-b');
    expect(copy.telegramChatId).toBe(file.telegramChatId);
    expect(copy.telegramMessageId).toBe(file.telegramMessageId);
    const replicas = await db.getRepository(models.TelegramFileCopy).findBy({ ownerType: 'file', ownerId: copy.id });
    expect(replicas).toHaveLength(1);
    expect(replicas[0].accountId).toBe('bot-b');
    // 即使副本查询为空，来源 Bot 回退仍不能将 bot-b 的 file_id 交给默认 Bot。
    const downloader = Object.create(services.FileService.prototype);
    const legacy = jest.fn();
    const source = jest.fn(async () => ({ stream: Readable.from('data'), info: {} }));
    Object.assign(downloader, { accountAwareDownload: { isActive: () => true, openSourceStream: source },
      fileCopies: { listReady: async () => [] }, configService: { get: () => 'bot-a:inert-test-value' },
      telegramService: { getRealtimeFileStream: legacy } });
    await downloader.openTelegramSourceStream(copy, 10);
    expect(source).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'bot-b', fileId: file.telegramFileId }));
    expect(legacy).not.toHaveBeenCalled();
  });

  it('copy refuses a source overwritten between initial lookup and transaction', async () => {
    const namespace = new services.DirectoryNamespaceService(db);
    jest.spyOn(namespace, 'isNameTaken').mockImplementationOnce(async () => {
      await db.getRepository(models.File).update(file.id, { uploadVersion: file.uploadVersion + 1 });
      return false;
    });
    const folders = new services.FolderService(db.getTreeRepository(models.Folder), db.getRepository(models.File), audit, namespace);
    await expect(folders.copyFile(owner.id, file.id, {})).rejects.toThrow('源文件已变化');
    expect(await db.getRepository(models.File).countBy({ uploaderId: owner.id })).toBe(1);
  });
});
