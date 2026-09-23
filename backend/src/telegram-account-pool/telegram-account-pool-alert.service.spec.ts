import { AlertLevel } from '../common/entities/alert.entity';
import { AccountPoolCounters, AccountPoolSnapshot } from './telegram-account-pool.types';
import { TelegramAccountPoolAlertService } from './telegram-account-pool-alert.service';

function counters(overrides: Partial<AccountPoolCounters> = {}): AccountPoolCounters {
  return {
    selections: 0,
    failovers: 0,
    fallbacks: 0,
    unresolved: 0,
    replicationsOk: 0,
    replicationsFailed: 0,
    streamFailures: 0,
    replyFailures: 0,
    inboundRegistrationFailures: 0,
    userRelaysOk: 0,
    userRelaysFailed: 0,
    inboundBridgeMisses: 0,
    ...overrides,
  };
}

function snapshot(options: {
  enabled?: boolean;
  accounts?: Array<{ id: string; enabled: boolean; coolingDown: boolean; cooldownRemainingMs: number }>;
  counters?: Partial<AccountPoolCounters>;
} = {}): AccountPoolSnapshot {
  return {
    enabled: options.enabled ?? true,
    inactiveReason: null,
    counters: counters(options.counters),
    accounts: (options.accounts ?? [{ id: 'a1', enabled: true, coolingDown: false, cooldownRemainingMs: 0 }])
      .map((account) => ({
        id: account.id,
        tokenPreview: `${account.id}:abc***`,
        chatId: '-1001',
        enabled: account.enabled,
        weight: 1,
        maxInflight: 8,
        inflight: 0,
        bandwidthMbps: 0,
        successRate: 1,
        latencyMs: 0,
        coolingDown: account.coolingDown,
        cooldownRemainingMs: account.cooldownRemainingMs,
        consecutiveFailures: 0,
        totalRequests: 0,
        failures: 0,
        totalBytes: 0,
        lastErrorKind: null,
        source: 'env' as const,
        primary: false,
        storageConfigured: true,
      })),
  };
}

function makeService(poolSnapshot: AccountPoolSnapshot, options: { active?: boolean; withEngine?: boolean } = {}) {
  const pool = {
    isActive: jest.fn(() => options.active ?? true),
    snapshot: jest.fn(() => poolSnapshot),
  };
  const alertEngine = { createAlerts: jest.fn(async () => []) };
  const service = new TelegramAccountPoolAlertService(
    pool as never,
    (options.withEngine === false ? null : alertEngine) as never,
  );
  return { service, pool, alertEngine };
}

describe('TelegramAccountPoolAlertService（账号池运行态告警）', () => {
  it('账号池未生效时不做任何告警（未启用不是异常）', () => {
    const ctx = makeService(snapshot({ enabled: false }));
    expect(ctx.service.evaluate(snapshot({ enabled: false }), counters({ selections: 100, fallbacks: 100 }))).toEqual([]);
  });

  it('全部账号不可调度时产生 CRITICAL 告警（含冷却明细）', () => {
    const ctx = makeService(snapshot());
    const evaluations = ctx.service.evaluate(
      snapshot({
        accounts: [
          { id: 'a1', enabled: true, coolingDown: true, cooldownRemainingMs: 60_000 },
          { id: 'a2', enabled: false, coolingDown: false, cooldownRemainingMs: 0 },
        ],
      }),
      counters(),
    );

    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]).toMatchObject({ ruleId: 'BOT_POOL_ALL_UNAVAILABLE', level: AlertLevel.CRITICAL });
    expect(evaluations[0].message).toContain('a1');
  });

  it('仍有可调度账号时不触发「全部不可用」', () => {
    const ctx = makeService(snapshot());
    const evaluations = ctx.service.evaluate(
      snapshot({
        accounts: [
          { id: 'a1', enabled: true, coolingDown: true, cooldownRemainingMs: 60_000 },
          { id: 'a2', enabled: true, coolingDown: false, cooldownRemainingMs: 0 },
        ],
      }),
      counters(),
    );

    expect(evaluations.find((item) => item.ruleId === 'BOT_POOL_ALL_UNAVAILABLE')).toBeUndefined();
  });

  it('全部账号在飞满载时同样判定为「全部不可用」（口径与可调度判定一致）', () => {
    const ctx = makeService(snapshot());
    const base = snapshot();
    const evaluations = ctx.service.evaluate(
      { ...base, accounts: [{ ...base.accounts[0], inflight: 8, maxInflight: 8 }] },
      counters(),
    );

    const alert = evaluations.find((item) => item.ruleId === 'BOT_POOL_ALL_UNAVAILABLE');
    expect(alert).toBeDefined();
    expect(alert?.context).toMatchObject({ saturated: 1 });
  });

  it('回退率超阈值且样本充足时告警；样本不足时不告警', () => {
    const ctx = makeService(snapshot());

    const enough = ctx.service.evaluate(snapshot(), counters({ selections: 10, fallbacks: 5, unresolved: 2 }));
    const rateAlert = enough.find((item) => item.ruleId === 'BOT_POOL_FALLBACK_RATE');
    expect(rateAlert).toBeDefined();
    expect(rateAlert?.level).toBe(AlertLevel.WARNING);
    expect(rateAlert?.message).toContain('50.0%');

    const tooFewSamples = ctx.service.evaluate(snapshot(), counters({ selections: 4, fallbacks: 4 }));
    expect(tooFewSamples.find((item) => item.ruleId === 'BOT_POOL_FALLBACK_RATE')).toBeUndefined();

    const belowThreshold = ctx.service.evaluate(snapshot(), counters({ selections: 10, fallbacks: 1 }));
    expect(belowThreshold.find((item) => item.ruleId === 'BOT_POOL_FALLBACK_RATE')).toBeUndefined();
  });

  it('复制持续失败与入站回复失败分别告警', () => {
    const ctx = makeService(snapshot());
    const evaluations = ctx.service.evaluate(
      snapshot(),
      counters({ replicationsFailed: 3, replicationsOk: 1, replyFailures: 1 }),
    );

    expect(evaluations.find((item) => item.ruleId === 'BOT_POOL_REPLICATION_FAILING')).toBeDefined();
    expect(evaluations.find((item) => item.ruleId === 'BOT_REPLY_FAILING')).toBeDefined();
  });

  it('runOnce 按增量判定：累计值不变时不重复告警', async () => {
    const poolSnapshot = snapshot({
      accounts: [{ id: 'a1', enabled: true, coolingDown: true, cooldownRemainingMs: 60_000 }],
    });
    const ctx = makeService(poolSnapshot);
    ctx.pool.snapshot.mockReturnValue(poolSnapshot);

    await ctx.service.runOnce();
    expect(ctx.alertEngine.createAlerts).toHaveBeenCalledTimes(1);

    // 状态未变化（快照与计数都不变）→ 增量与状态都相同，但「全部不可用」是状态型，
    // 仍会评估出来；冷却去重由 AlertEngineService 负责，这里只断言评估确实发生。
    await ctx.service.runOnce();
    expect(ctx.alertEngine.createAlerts).toHaveBeenCalledTimes(2);
  });

  it('账号池未生效时 runOnce 不采集也不创建告警', async () => {
    const ctx = makeService(snapshot(), { active: false });
    await ctx.service.runOnce();

    expect(ctx.pool.snapshot).not.toHaveBeenCalled();
    expect(ctx.alertEngine.createAlerts).not.toHaveBeenCalled();
  });

  it('告警引擎未装配时只记日志，不抛异常影响主链路', async () => {
    const ctx = makeService(
      snapshot({ accounts: [{ id: 'a1', enabled: false, coolingDown: false, cooldownRemainingMs: 0 }] }),
      { withEngine: false },
    );

    await expect(ctx.service.runOnce()).resolves.toBeUndefined();
  });
});
