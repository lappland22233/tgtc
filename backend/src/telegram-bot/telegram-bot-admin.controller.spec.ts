import { TelegramBotAdminController } from './telegram-bot-admin.controller';

/**
 * 两个只读诊断端点的契约测试（`bot-account-pool` / `bot-inbound-status`）。
 *
 * 关注三件事：
 * 1. 委派：把服务快照原样投影出来（不丢字段、不改语义）；
 * 2. 降级：服务未装配时给出明确原因，而不是抛错或返回空对象；
 * 3. 白名单：只输出约定字段，任何额外字段（尤其是可能夹带 Token 与完整 `file_id` 的）都不得泄漏。
 */
function makeController(options: { polling?: unknown; accountPool?: unknown } = {}) {
  return new TelegramBotAdminController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    (options.accountPool ?? null) as never,
    (options.polling ?? null) as never,
  );
}

/** 账号池快照夹具：包含全部契约字段，便于按字段核对投影结果 */
function accountPoolSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    inactiveReason: null,
    counters: {
      selections: 12,
      failovers: 1,
      fallbacks: 0,
      unresolved: 0,
      replicationsOk: 3,
      replicationsFailed: 0,
      streamFailures: 0,
      replyFailures: 0,
      inboundRegistrationFailures: 0,
      userRelaysOk: 0,
      userRelaysFailed: 0,
      inboundBridgeMisses: 0,
    },
    accounts: [
      { id: '1234567', tokenPreview: '1234567:AAF***', chatId: '-100111', enabled: true, weight: 1 },
    ],
    ...overrides,
  };
}

describe('TelegramBotAdminController（bot-account-pool）', () => {
  it('未装配账号池模块时降级返回明确原因（未启用不等于 DI 失败）', async () => {
    const result = (await makeController().getAccountPoolStatus()) as unknown as Record<string, unknown>;

    expect(result.enabled).toBe(false);
    expect(result.inactiveReason).toContain('账号池模块未装配');
    expect(result.counters).toBeNull();
    expect(result.accounts).toEqual([]);
  });

  it('委派账号池快照：启用状态、未生效原因、计数与账号列表原样透出', async () => {
    const snapshot = accountPoolSnapshot();
    const result = (await makeController({ accountPool: { snapshot: () => snapshot } })
      .getAccountPoolStatus()) as unknown as Record<string, unknown>;

    // 只允许这四个字段：多一个字段就是契约漂移
    expect(result).toEqual({
      enabled: snapshot.enabled,
      inactiveReason: snapshot.inactiveReason,
      counters: snapshot.counters,
      accounts: snapshot.accounts,
    });
    // 账号标识与已脱敏预览必须保留——它们正是「已启用但未生效」的可诊断依据
    expect((result.accounts as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: '1234567',
      tokenPreview: '1234567:AAF***',
      chatId: '-100111',
    });
  });

  it('只按白名单字段投影：Token 原文、完整 file_id 与原始地址都不会泄漏', async () => {
    const result = (await makeController({
      accountPool: {
        snapshot: () => accountPoolSnapshot({
          // 以下字段不属于对外契约：一旦出现在响应里就是凭据 / 标识泄漏风险
          rawToken: '1234567:AAF-secret',
          fullFileId: 'BQACAgQAAxkBAAI_pool_full_file_id',
          upstreamUrl: 'https://api.telegram.org/bot1234567:AAF-secret/getFile',
        }),
      },
    }).getAccountPoolStatus()) as unknown as Record<string, unknown>;
    const serialized = JSON.stringify(result);

    expect(result.rawToken).toBeUndefined();
    expect(result.fullFileId).toBeUndefined();
    expect(result.upstreamUrl).toBeUndefined();
    expect(serialized).not.toContain('AAF-secret');
    expect(serialized).not.toContain('BQACAgQAAxkBAAI_pool_full_file_id');
    expect(serialized).not.toContain('api.telegram.org');
  });
});

describe('TelegramBotAdminController（bot-inbound-status）', () => {
  it('未装配轮询服务时降级返回明确原因', () => {
    const controller = makeController();

    const result = controller.getInboundStatus() as Record<string, unknown>;

    expect(result.unavailableReason).toContain('入站轮询服务未装配');
    expect(result.enabled).toBe(false);
    expect(result.mode).toBe('disabled');
    expect(result.accounts).toEqual([]);
  });

  it('委派轮询服务快照：模式、计数与逐账号状态原样透出', () => {
    const snapshot = {
      enabled: true,
      mode: 'pooled',
      running: true,
      startedAtMs: 1_700_000_000_000,
      lastPollAtMs: 1_700_000_005_000,
      selfCheck: { atMs: 1_700_000_020_000, healthy: true, message: '1 个账号入站轮询正常' },
      modeDrift: { restartRequired: false, reason: null },
      accounts: [
        {
          accountId: '123456',
          running: true,
          offset: 939050191,
          pollCount: 7,
          updateCount: 1,
          consecutiveFailures: 0,
          lastPollAtMs: 1_700_000_005_000,
          lastErrorAtMs: null,
          lastErrorSummary: null,
        },
      ],
    };
    const controller = makeController({ polling: { snapshot: () => snapshot } });

    const result = controller.getInboundStatus() as Record<string, unknown>;

    expect(result).toEqual({ ...snapshot });
    expect(result.unavailableReason).toBeUndefined();
  });

  it('只按白名单字段投影，快照里的额外字段不会泄漏到响应', () => {
    const controller = makeController({
      polling: {
        snapshot: () => ({
          enabled: true,
          mode: 'pooled',
          running: true,
          startedAtMs: 1,
          lastPollAtMs: 2,
          selfCheck: null,
          modeDrift: { restartRequired: false, reason: null },
          accounts: [],
          // 以下字段不属于对外契约：一旦出现在响应里就是凭据 / 标识泄漏风险
          rawToken: '123456:AAF-secret',
          fullFileId: 'BQACAgQAAxkBAAI_inbound_full_file_id',
          upstreamUrl: 'https://api.telegram.org/bot123456:AAF-secret/getUpdates',
        }),
      },
    });

    const result = controller.getInboundStatus() as Record<string, unknown>;
    const serialized = JSON.stringify(result);

    expect(result.rawToken).toBeUndefined();
    expect(result.fullFileId).toBeUndefined();
    expect(result.upstreamUrl).toBeUndefined();
    expect(serialized).not.toContain('AAF-secret');
    expect(serialized).not.toContain('BQACAgQAAxkBAAI_inbound_full_file_id');
    expect(serialized).not.toContain('api.telegram.org');
  });
});
