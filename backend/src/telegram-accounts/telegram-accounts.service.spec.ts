import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
// 每个用例都会新建 SQLite 内存库并跑基线迁移；满负载串行执行时会超过 jest 默认 5s
jest.setTimeout(30_000);
import type { BotProbeResult } from './telegram-account-probe.service';

/** 固定 32 字节测试根密钥（仅测试用，生产由环境变量提供） */
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

/**
 * 断言 HTTP 状态码。
 *
 * 为什么不用 `toBeInstanceOf`：本用例用 `jest.resetModules()` 隔离方言相关模块，
 * 被测模块内部加载的是**另一份** `@nestjs/common` 注册表，异常类的 `instanceof`
 * 会跨注册表失效。这里改为读取异常自身的状态码。
 */
async function expectHttpStatus(promise: Promise<unknown>, status: number): Promise<void> {
  await expect(promise).rejects.toThrow();
  await promise.catch((error: { getStatus?: () => number; status?: number }) => {
    const actual = typeof error.getStatus === 'function' ? error.getStatus() : error.status;
    expect(actual).toBe(status);
  });
}

describe('TelegramAccountsService（SQLite 内存库）', () => {
  let dataSource: DataSource;
  const originalDbType = process.env.DB_TYPE;
  const originalKey = process.env.TELEGRAM_ACCOUNT_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.DB_TYPE = 'sqlite';
    process.env.TELEGRAM_ACCOUNT_ENCRYPTION_KEY = TEST_KEY;
    jest.resetModules();
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (originalDbType === undefined) delete process.env.DB_TYPE;
    else process.env.DB_TYPE = originalDbType;
    if (originalKey === undefined) delete process.env.TELEGRAM_ACCOUNT_ENCRYPTION_KEY;
    else process.env.TELEGRAM_ACCOUNT_ENCRYPTION_KEY = originalKey;
  });

  async function setup(probeResult?: Partial<{ ok: boolean; error: string | null; errorCode: string | null }>) {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { databaseEntities } = require('../database/entities') as typeof import('../database/entities');
    const { SqliteEntitySchema1700000000000 } = require('../migrations/0000000000000-SqliteEntitySchema') as typeof import('../migrations/0000000000000-SqliteEntitySchema');
    const { TelegramAccountCredentialService } = require('./telegram-account-credential.service') as typeof import('./telegram-account-credential.service');
    const { TelegramAccountFeatureService } = require('./telegram-account-feature.service') as typeof import('./telegram-account-feature.service');
    const { TelegramAccountsService } = require('./telegram-accounts.service') as typeof import('./telegram-accounts.service');
    /* eslint-enable @typescript-eslint/no-var-requires */

    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [...databaseEntities],
      migrations: [SqliteEntitySchema1700000000000],
      migrationsRun: true,
      synchronize: false,
    });
    await dataSource.initialize();

    const configService = new ConfigService();
    const credentials = new TelegramAccountCredentialService(configService);
    const store = new Map<string, string>();
    const configCache = {
      get: async (key: string, fallback: string) => store.get(key) ?? fallback,
      set: async (key: string, value: string) => { store.set(key, value); },
    };
    const feature = new TelegramAccountFeatureService(configCache as never, configService);
    const probeBot = jest.fn(
      async (_token: string, _chatId?: string | null): Promise<BotProbeResult> => ({
        ok: probeResult?.ok ?? true,
        botId: '123456',
        username: 'demo_bot',
        displayName: null,
        chatTitle: '存储群',
        chatType: 'supergroup',
        capabilities: { canUpload: true, supportsPolling: true, canWriteMirror: true },
        error: probeResult?.error ?? null,
        errorCode: probeResult?.errorCode ?? null,
      }),
    );
    const probe = { probeBot };
    const audit = { log: jest.fn() };
    const userClient = { isAvailable: () => true, unavailableReason: () => null };
    // 账号池只读取注册表做去重/运行态展示；默认「无环境变量账号」以保持既有用例语义
    const envTokens = new Set<string>();
    const envSnapshots: Array<Record<string, unknown>> = [];
    const recordProbe = jest.fn();
    const pool = {
      isTokenRegistered: (token: string) => envTokens.has(token),
      isEnvTokenRegistered: (token: string) => envTokens.has(token),
      isEnvAccount: (id: string) => envSnapshots.some((item) => item.id === id),
      primaryAccountId: () => (envSnapshots.find((item) => item.primary)?.id as string | undefined) ?? null,
      ids: () => envSnapshots.map((item) => item.id as string),
      getConfig: (id: string) => {
        const snapshot = envSnapshots.find((item) => item.id === id);
        if (!snapshot) return null;
        return {
          id,
          token: `${id}:SECRET-VALUE-NEVER-EXPOSED`,
          chatId: (snapshot.chatId as string) ?? '',
          weight: 1,
          maxInflight: 8,
          enabled: true,
          source: (snapshot.source as 'env' | 'panel') ?? 'env',
          primary: snapshot.primary === true,
        };
      },
      recordProbe,
      runtimeView: (id: string) => envSnapshots.find((item) => item.id === id) ?? null,
      snapshot: () => ({
        enabled: envSnapshots.length > 0,
        inactiveReason: null,
        counters: {} as never,
        accounts: envSnapshots,
      }),
    };

    const service = new TelegramAccountsService(
      dataSource.getRepository((require('../common/entities/telegram-account.entity') as typeof import('../common/entities/telegram-account.entity')).TelegramAccount),
      credentials,
      feature,
      probe as never,
      userClient as never,
      audit as never,
      pool as never,
    );
    return {
      service,
      repo: dataSource.getRepository((require('../common/entities/telegram-account.entity') as typeof import('../common/entities/telegram-account.entity')).TelegramAccount),
      credentials,
      feature,
      probe,
      audit,
      pool,
      envTokens,
      envSnapshots,
      recordProbe,
    };
  }

  /** 环境变量主 Bot 的池快照桩（字段与 `AccountPoolAccountSnapshot` 对齐） */
  function primarySnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: '123456',
      tokenPreview: '123456:AAF***',
      chatId: '-1001234567890',
      enabled: true,
      weight: 1,
      maxInflight: 8,
      inflight: 2,
      bandwidthMbps: 1.5,
      successRate: 0.98,
      latencyMs: 42,
      coolingDown: false,
      cooldownRemainingMs: 0,
      consecutiveFailures: 0,
      totalRequests: 10,
      failures: 0,
      totalBytes: 1024,
      lastErrorKind: null,
      source: 'env',
      primary: true,
      storageConfigured: true,
      ...overrides,
    };
  }

  const BOT_TOKEN = '123456:AAF-DEMO-TOKEN-VALUE';

  it('创建 Bot：校验通过后落库，凭据只以密文保存且视图不泄露 Token', async () => {
    const { service, repo } = await setup();
    const view = await service.createBot(
      { name: '主存储 Bot', token: BOT_TOKEN, primaryChatId: '-1001234567890' },
      'admin-1',
    );

    expect(view.status).toBe('active');
    expect(view.enabled).toBe(true);
    expect(view.externalId).toBe('***3456');
    expect(view.credentialConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain('AAF-DEMO-TOKEN-VALUE');

    const stored = await repo.createQueryBuilder('account')
      .addSelect('account.credentialCiphertext')
      .getOneOrFail();
    expect(stored.credentialCiphertext).toContain('v1:');
    expect(stored.credentialCiphertext).not.toContain('AAF-DEMO-TOKEN-VALUE');
  });

  it('创建 Bot：探测失败时拒绝落库，不留下不可用账号', async () => {
    const { service, repo } = await setup({ ok: false, error: '主存储 Chat 不可访问：chat not found', errorCode: 'probe_chat_unreachable' });
    await expectHttpStatus(service.createBot({ name: '坏 Bot', token: BOT_TOKEN }, 'admin-1'), 400);
    expect(await repo.count()).toBe(0);
  });

  it('创建 Bot：同一 Bot ID 重复登记被拒绝', async () => {
    const { service } = await setup();
    await service.createBot({ name: '主存储 Bot', token: BOT_TOKEN }, 'admin-1');
    await expectHttpStatus(service.createBot({ name: '重复 Bot', token: BOT_TOKEN }, 'admin-1'), 409);
  });

  it('创建 Bot：Token 已被环境变量账号注册时拒绝（后台只读，避免双账号假象）', async () => {
    const { service, repo, envTokens } = await setup();
    envTokens.add(BOT_TOKEN);

    await expectHttpStatus(service.createBot({ name: '重复主 Bot', token: BOT_TOKEN }, 'admin-1'), 409);
    // 拒绝必须发生在落库前：不得留下「看起来存在但被环境变量屏蔽」的账号
    expect(await repo.count()).toBe(0);
  });

  it('用户账号：创建后停留在待授权、不参与任务；授权完成后转为启用', async () => {
    const { service, credentials } = await setup();
    const created = await service.createUser(
      { name: '用户账号 A', apiId: 12345, apiHash: 'abcdef0123456789', phoneNumber: '+8613800000000' },
      'admin-1',
    );
    expect(created.status).toBe('pending_auth');
    expect(created.enabled).toBe(false);
    await expectHttpStatus(service.update(created.id, { enabled: true }, 'admin-1'), 400);

    await service.completeUserAuthorization(
      created.id,
      { session: 'SESSION-STRING-SECRET', identity: { userId: '700123456', username: 'demo' }, capabilities: { canReadSource: true } },
      'admin-1',
    );
    const detail = await service.detail(created.id);
    expect(detail.status).toBe('active');
    expect(detail.enabled).toBe(true);
    expect(detail.externalId).toBe('***3456');
    expect(JSON.stringify(detail)).not.toContain('SESSION-STRING-SECRET');

    const resolved = await service.resolveCredential(created.id);
    expect(resolved?.payload.session).toBe('SESSION-STRING-SECRET');
    expect(credentials.isAvailable()).toBe(true);
  });

  it('启停与撤销：停用转 disabled；撤销清空凭据且不可再启用', async () => {
    const { service } = await setup();
    const created = await service.createBot({ name: '主存储 Bot', token: BOT_TOKEN }, 'admin-1');

    const disabled = await service.update(created.id, { enabled: false }, 'admin-1');
    expect(disabled.enabled).toBe(false);
    expect(disabled.status).toBe('disabled');

    const enabled = await service.update(created.id, { enabled: true }, 'admin-1');
    expect(enabled.status).toBe('active');

    const revoked = await service.remove(created.id, 'admin-1');
    expect(revoked.status).toBe('revoked');
    expect(revoked.credentialConfigured).toBe(false);
    await expectHttpStatus(service.update(created.id, { enabled: true }, 'admin-1'), 400);
    expect(await service.resolveCredential(created.id)).toBeNull();
  });

  it('轮换：新 Token 校验失败时保持不变；成功后替换密文', async () => {
    const { service, credentials, probe } = await setup();
    const created = await service.createBot({ name: '主存储 Bot', token: BOT_TOKEN }, 'admin-1');

    probe.probeBot.mockResolvedValueOnce({
      ok: false,
      botId: null,
      username: null,
      displayName: null,
      chatTitle: null,
      chatType: null,
      capabilities: { canUpload: false },
      error: 'Unauthorized',
      errorCode: 'probe_get_me_failed',
    } satisfies BotProbeResult);
    await expectHttpStatus(service.rotateBot(created.id, { token: '999999:NEW-TOKEN-VALUE-XXXX' }, 'admin-1'), 400);
    const afterFailedRotate = await service.resolveCredential(created.id);
    expect(afterFailedRotate?.payload.token).toBe(BOT_TOKEN);

    probe.probeBot.mockResolvedValue({
      ok: true,
      botId: '999999',
      username: 'new_bot',
      displayName: null,
      chatTitle: null,
      chatType: null,
      capabilities: { canUpload: true },
      error: null,
      errorCode: null,
    } satisfies BotProbeResult);
    const rotated = await service.rotateBot(created.id, { token: '999999:NEW-TOKEN-VALUE-XXXX' }, 'admin-1');
    expect(rotated.externalId).toBe('***9999');
    const afterRotate = await service.resolveCredential(created.id);
    expect(afterRotate?.payload.token).toBe('999999:NEW-TOKEN-VALUE-XXXX');
    expect(credentials.cipherVersion()).toBe('v1');
  });

  it('轮换：新 Token 命中环境变量账号时拒绝（不得造出同一 Bot 的两个逻辑账号）', async () => {
    const { service, envTokens, probe } = await setup();
    const created = await service.createBot({ name: '主存储 Bot', token: BOT_TOKEN }, 'admin-1');
    envTokens.add('999999:ENV-TOKEN-VALUE');

    await expectHttpStatus(service.rotateBot(created.id, { token: '999999:ENV-TOKEN-VALUE' }, 'admin-1'), 409);
    // 必须在探测与落库之前拒绝：探测次数应仍停留在「创建时那一次」
    expect(probe.probeBot).toHaveBeenCalledTimes(1);
    const after = await service.resolveCredential(created.id);
    expect(after?.payload.token).toBe(BOT_TOKEN);
  });

  it('账号池取号：只返回启用且非 revoked/pending_auth 的 Bot 账号', async () => {
    const { service } = await setup();
    const active = await service.createBot({ name: 'A', token: '111111:AAAAAAAAAAAA' }, 'admin-1');
    const disabled = await service.createBot({ name: 'B', token: '222222:BBBBBBBBBBBB' }, 'admin-1');
    await service.update(disabled.id, { enabled: false }, 'admin-1');
    const revoked = await service.createBot({ name: 'C', token: '333333:CCCCCCCCCCCC' }, 'admin-1');
    await service.remove(revoked.id, 'admin-1');

    const pool = await service.resolveEnabledBotAccounts();
    expect(pool.map((item) => item.accountId)).toEqual(['111111']);
    expect(pool[0].token).toBe('111111:AAAAAAAAAAAA');
    expect(active.id).toBeTruthy();
  });

  it('缺少根密钥时拒绝创建账号（绝不落明文）', async () => {
    delete process.env.TELEGRAM_ACCOUNT_ENCRYPTION_KEY;
    const { service, repo } = await setup();
    await expectHttpStatus(service.createBot({ name: 'Bot', token: BOT_TOKEN }, 'admin-1'), 400);
    expect(await repo.count()).toBe(0);

    const overview = await service.overview();
    expect(overview.credentialCryptoAvailable).toBe(false);
    expect(overview.precheck.find((item) => item.id === 'credential_crypto')?.ok).toBe(false);
  });

  it('总览：计数与能力前置检查反映真实状态', async () => {
    const { service, feature } = await setup();
    await service.createBot({ name: 'A', token: '111111:AAAAAAAAAAAA' }, 'admin-1');
    const overview = await service.overview();
    expect(overview.counts.total).toBe(1);
    expect(overview.counts.bot).toBe(1);
    expect(overview.counts.enabled).toBe(1);
    expect(overview.precheck.find((item) => item.id === 'usable_account')?.ok).toBe(true);
    expect(overview.feature.accountPoolEnabled).toBe(false);

    await feature.setAccountPoolEnabled(true);
    expect((await feature.getState()).accountPoolEnabled).toBe(true);
    expect((await feature.getState()).accountPoolSource).toBe('runtime');
  });

  it('账号列表：支持类型与关键字筛选并返回脱敏视图', async () => {
    const { service } = await setup();
    await service.createBot({ name: '主存储 Bot', token: '111111:AAAAAAAAAAAA' }, 'admin-1');
    await service.createUser({ name: '用户账号', apiId: 1, apiHash: 'hashhashhash' }, 'admin-1');

    const bots = await service.list({ type: 'bot' });
    expect(bots.total).toBe(1);
    expect(bots.items[0].type).toBe('bot');
    const keyword = await service.list({ keyword: '用户' });
    expect(keyword.total).toBe(1);
    expect(keyword.items[0].type).toBe('user');
  });

  it('总览：暴露环境变量主 Bot 的只读脱敏视图与池运行态', async () => {
    const { service, envSnapshots } = await setup();
    envSnapshots.push(primarySnapshot());

    const overview = await service.overview();
    expect(overview.pool.primaryAccountId).toBe('123456');
    expect(overview.pool.accountCount).toBe(1);
    expect(overview.pool.envAccountCount).toBe(1);
    expect(overview.envAccounts).toHaveLength(1);

    const env = overview.envAccounts[0];
    expect(env).toMatchObject({ id: '123456', primary: true, source: 'env', readOnly: true, enabled: true });
    expect(env.runtime).toMatchObject({ inflight: 2, maxInflight: 8, storageConfigured: true });
    expect(overview.precheck.find((item) => item.id === 'primary_bot')?.ok).toBe(true);
    expect(overview.precheck.find((item) => item.id === 'env_storage_chat')?.ok).toBe(true);
    // 脱敏：环境变量账号视图不得出现完整 Token
    expect(JSON.stringify(overview)).not.toContain('SECRET-VALUE-NEVER-EXPOSED');
  });

  it('总览：环境变量账号缺存储 Chat 时预检提示，且不影响其它账号', async () => {
    const { service, envSnapshots } = await setup();
    envSnapshots.push(primarySnapshot({ chatId: '', storageConfigured: false }));

    const overview = await service.overview();
    expect(overview.envAccounts[0].chatId).toBeNull();
    expect(overview.envAccounts[0].runtime.storageConfigured).toBe(false);
    expect(overview.precheck.find((item) => item.id === 'env_storage_chat')?.ok).toBe(false);
  });

  it('列表：与环境变量同 Bot 的数据库账号标记双来源并带运行态；用户查询不返回环境变量账号', async () => {
    const { service, envSnapshots } = await setup();
    await service.createBot({ name: '主存储 Bot', token: BOT_TOKEN, primaryChatId: '-1' }, 'admin-1');
    envSnapshots.push(primarySnapshot());

    const bots = await service.list({ type: 'bot' });
    expect(bots.items[0].source).toBe('both');
    expect(bots.items[0].runtime?.inflight).toBe(2);
    expect(bots.envAccounts).toHaveLength(1);
    expect(JSON.stringify(bots)).not.toContain('SECRET-VALUE-NEVER-EXPOSED');

    const users = await service.list({ type: 'user' });
    expect(users.envAccounts).toEqual([]);
  });

  it('探测环境变量账号：结论回写池运行态并写审计（不泄露 Token）', async () => {
    const { service, envSnapshots, recordProbe, audit } = await setup();
    envSnapshots.push(primarySnapshot());

    const result = await service.probeEnvAccount('123456', 'admin-1');
    expect(result.ok).toBe(true);
    expect(result.message).toBe('环境变量账号探测通过');
    expect(recordProbe).toHaveBeenCalledWith('123456', true, expect.any(Number), undefined);

    const audited = audit.log.mock.calls.at(-1)?.[0] as { metadata?: Record<string, unknown> };
    expect(audited.metadata?.source).toBe('env');
    expect(audited.metadata?.primary).toBe(true);
    expect(JSON.stringify(audited)).not.toContain('SECRET-VALUE-NEVER-EXPOSED');
  });

  it('探测环境变量账号：失败结论同样回写运行态（失败必须立即影响选号）', async () => {
    const { service, envSnapshots, recordProbe, probe } = await setup({ ok: false, error: 'Unauthorized', errorCode: 'probe_get_me_failed' });
    envSnapshots.push(primarySnapshot());

    const result = await service.probeEnvAccount('123456', 'admin-1');
    expect(result.ok).toBe(false);
    expect(probe.probeBot).toHaveBeenCalledWith('123456:SECRET-VALUE-NEVER-EXPOSED', '-1001234567890');
    expect(recordProbe).toHaveBeenCalledWith('123456', false, expect.any(Number), 'Unauthorized');
  });

  it('探测环境变量账号：未注册返回 404，数据库账号返回 400（不得混用入口）', async () => {
    const { service, envSnapshots } = await setup();
    await expectHttpStatus(service.probeEnvAccount('123456', 'admin-1'), 404);

    envSnapshots.push(primarySnapshot({ source: 'panel', primary: false }));
    await expectHttpStatus(service.probeEnvAccount('123456', 'admin-1'), 400);
  });
});
