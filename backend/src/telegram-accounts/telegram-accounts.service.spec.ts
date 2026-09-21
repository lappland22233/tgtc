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

    const service = new TelegramAccountsService(
      dataSource.getRepository((require('../common/entities/telegram-account.entity') as typeof import('../common/entities/telegram-account.entity')).TelegramAccount),
      credentials,
      feature,
      probe as never,
      userClient as never,
      audit as never,
    );
    return { service, repo: dataSource.getRepository((require('../common/entities/telegram-account.entity') as typeof import('../common/entities/telegram-account.entity')).TelegramAccount), credentials, feature, probe, audit };
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
});
