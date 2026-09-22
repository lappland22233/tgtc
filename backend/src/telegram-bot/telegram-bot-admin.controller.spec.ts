import { TelegramBotAdminController } from './telegram-bot-admin.controller';

/**
 * 入站诊断端点的契约测试。
 *
 * 关注三件事：
 * 1. 委派：把轮询服务的快照原样投影出来（不丢字段、不改语义）；
 * 2. 降级：轮询服务未装配时给出明确原因，而不是抛错或返回空对象；
 * 3. 白名单：只输出约定字段，任何额外字段（尤其是可能夹带凭据的）都不得泄漏。
 */
function makeController(options: { polling?: unknown } = {}) {
  return new TelegramBotAdminController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    null as never,
    (options.polling ?? null) as never,
  );
}

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
          // 以下字段不属于对外契约：一旦出现在响应里就是凭据泄漏风险
          rawToken: '123456:AAF-secret',
          upstreamUrl: 'https://api.telegram.org/bot123456:AAF-secret/getUpdates',
        }),
      },
    });

    const result = controller.getInboundStatus() as Record<string, unknown>;
    const serialized = JSON.stringify(result);

    expect(result.rawToken).toBeUndefined();
    expect(result.upstreamUrl).toBeUndefined();
    expect(serialized).not.toContain('AAF-secret');
    expect(serialized).not.toContain('api.telegram.org');
  });
});
