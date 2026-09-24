import { AlertRuleEvaluation } from '../alert/alert.rules';
import { AlertLevel } from '../common/entities/alert.entity';
import { AccountPoolCounters, AccountPoolSnapshot } from './telegram-account-pool.types';
import { RelayAlertContext, TelegramAccountPoolAlertService } from './telegram-account-pool-alert.service';

/** 未采集到任何外部事实时的上下文（三条观测面规则一律不触发） */
function emptyContext(overrides: Partial<RelayAlertContext> = {}): RelayAlertContext {
  return {
    relayNotReadyReason: null,
    observabilityDegraded: false,
    observabilityReason: null,
    observabilityWriteFailures: 0,
    largeFileCoverage: null,
    ...overrides,
  };
}

function counters(overrides: Partial<AccountPoolCounters> = {}): AccountPoolCounters {
  return {
    selections: 0,
    failovers: 0,
    fallbacks: 0,
    unresolved: 0,
    streamFailures: 0,
    replyFailures: 0,
    inboundRegistrationFailures: 0,
    relayAttempts: 0,
    relaySucceeded: 0,
    relayFailed: 0,
    relayClaimsMissed: 0,
    inboundBridgeMisses: 0,
    anchorConflicts: 0,
    fallbackThrottled: 0,
    largeFileSlotThrottled: 0,
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
        largeInflight: 0,
        maxLargeInflight: 1,
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

function makeService(
  poolSnapshot: AccountPoolSnapshot,
  options: {
    active?: boolean;
    withEngine?: boolean;
    capability?: unknown;
    attempts?: unknown;
    copies?: unknown;
    replicaTargets?: unknown;
  } = {},
) {
  const pool = {
    isActive: jest.fn(() => options.active ?? true),
    snapshot: jest.fn(() => poolSnapshot),
  };
  const alertEngine = { createAlerts: jest.fn(async (_evaluations: AlertRuleEvaluation[]) => []) };
  const service = new TelegramAccountPoolAlertService(
    pool as never,
    (options.withEngine === false ? null : alertEngine) as never,
    (options.capability ?? null) as never,
    (options.attempts ?? null) as never,
    (options.copies ?? null) as never,
    (options.replicaTargets ?? null) as never,
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

  it('中继持续失败与入站回复失败分别告警，且文案不再承诺任何回退', () => {
    const ctx = makeService(snapshot());
    const evaluations = ctx.service.evaluate(
      snapshot(),
      counters({ relayAttempts: 4, relayFailed: 3, relaySucceeded: 1, replyFailures: 1 }),
    );

    const relayAlert = evaluations.find((item) => item.ruleId === 'RELAY_FAILURE_BURST');
    expect(relayAlert).toBeDefined();
    expect(relayAlert?.level).toBe(AlertLevel.WARNING);
    expect(relayAlert?.context).toMatchObject({ failed: 3, ok: 1, attempts: 4 });
    // 策略 A 已移除：告警文案绝不能再承诺任何回退路径
    expect(relayAlert?.message).not.toContain('回退策略 A');
    expect(relayAlert?.message).not.toContain('逐账号二次上传');
    expect(relayAlert?.message).toContain('不存在任何字节二次传输的降级路径');

    expect(evaluations.find((item) => item.ruleId === 'BOT_REPLY_FAILING')).toBeDefined();
  });

  it('中继成功但无人认领单独告警（转发成功不等于副本 ready）', () => {
    const ctx = makeService(snapshot());
    const evaluations = ctx.service.evaluate(
      snapshot(),
      counters({ relayAttempts: 2, relaySucceeded: 2, relayClaimsMissed: 1 }),
    );

    const claimAlert = evaluations.find((item) => item.ruleId === 'RELAY_CLAIM_TIMEOUT_BURST');
    expect(claimAlert).toBeDefined();
    expect(claimAlert?.level).toBe(AlertLevel.WARNING);
    expect(claimAlert?.message).toContain('隐私模式');
    // 中继成功但无人认领不属于「中继失败」：不得重复计入失败告警
    expect(evaluations.find((item) => item.ruleId === 'RELAY_FAILURE_BURST')).toBeUndefined();
  });

  it('中继正常时不误报（低流量部署不得被高频规则打扰）', () => {
    const ctx = makeService(snapshot());
    const evaluations = ctx.service.evaluate(
      snapshot(),
      counters({ relayAttempts: 3, relaySucceeded: 3 }),
    );

    expect(evaluations.find((item) => item.ruleId === 'RELAY_FAILURE_BURST')).toBeUndefined();
    expect(evaluations.find((item) => item.ruleId === 'RELAY_CLAIM_TIMEOUT_BURST')).toBeUndefined();
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

  it('中继已启用但不可用时告警，并给出可执行的排查入口', () => {
    const ctx = makeService(snapshot());
    const evaluations = ctx.service.evaluate(
      snapshot(),
      counters(),
      emptyContext({ relayNotReadyReason: '未解析到中继目标群（需配置并启用镜像规则目标群）' }),
    );

    const alert = evaluations.find((item) => item.ruleId === 'RELAY_NOT_READY');
    expect(alert).toBeDefined();
    expect(alert?.level).toBe(AlertLevel.CRITICAL);
    expect(alert?.message).toContain('未解析到中继目标群');
    expect(alert?.message).toContain('relay-preflight');
    // 契约：绝不承诺任何字节二次传输的降级路径
    expect(alert?.message).toContain('不会发生任何字节二次传输');
  });

  it('大文件覆盖率退化按主分层判定；空分层不算退化', () => {
    const ctx = makeService(snapshot());
    const degraded = ctx.service.evaluate(
      snapshot(),
      counters(),
      emptyContext({
        largeFileCoverage: { label: '≥4GiB', files: 3, unsatisfied: 1, readyAccounts: 1, schedulableAccounts: 2 },
      }),
    );

    const alert = degraded.find((item) => item.ruleId === 'LARGE_FILE_COVERAGE_DEGRADED');
    expect(alert).toBeDefined();
    expect(alert?.level).toBe(AlertLevel.WARNING);
    expect(alert?.message).toContain('1/3');
    expect(alert?.message).toContain('仅支持单轮手动重试');

    const noFiles = ctx.service.evaluate(
      snapshot(),
      counters(),
      emptyContext({
        largeFileCoverage: { label: '≥4GiB', files: 0, unsatisfied: 0, readyAccounts: 0, schedulableAccounts: 1 },
      }),
    );
    expect(noFiles.find((item) => item.ruleId === 'LARGE_FILE_COVERAGE_DEGRADED')).toBeUndefined();
  });

  it('观测降级时告警：不得把「看不到失败」当成没有失败', () => {
    const ctx = makeService(snapshot());
    const evaluations = ctx.service.evaluate(
      snapshot(),
      counters(),
      emptyContext({
        observabilityDegraded: true,
        observabilityReason: '轮次写入失败：disk full',
        observabilityWriteFailures: 3,
      }),
    );

    const alert = evaluations.find((item) => item.ruleId === 'REPLICATION_OBSERVABILITY_GAP');
    expect(alert).toBeDefined();
    expect(alert?.message).toContain('disk full');
    expect(alert?.context).toMatchObject({ writeFailures: 3 });
  });

  it('runOnce 采集能力快照：中继已启用但缺目标群时产生 CRITICAL 告警', async () => {
    const capability = {
      refreshFacts: jest.fn(async () => undefined),
      snapshot: jest.fn(() => ({
        relayEnabledByConfig: true,
        userClientAvailable: true,
        userClientUnavailableReason: null,
        enabledAuthorizedUserCount: 1,
        resolvedTargetChatIdPreview: null,
        sourceChatIdPreview: null,
        sourceChatReadable: 'not_checked',
        targetChatWritable: 'not_checked',
        botsCanReceiveRelay: 'not_checked',
        checkedAt: null,
        checkStatus: 'not_checked',
        notes: [],
      })),
    };
    const ctx = makeService(snapshot(), { capability });

    await ctx.service.runOnce();

    const created = ctx.alertEngine.createAlerts.mock.calls[0][0];
    expect(created.map((item) => item.ruleId)).toContain('RELAY_NOT_READY');
  });

  it('大文件覆盖率按低频节流采集，采集失败不影响其余告警', async () => {
    const copies = {
      replicationCoverageBySize: jest.fn(async () => ({
        scannedFiles: 3,
        truncated: false,
        tiers: [{
          label: '≥4GiB',
          minBytes: 4 * 1024 ** 3,
          files: 3,
          satisfied: 2,
          unsatisfied: 1,
          readyAccountCounts: [1, 2, 2],
          missingSamples: [],
        }],
      })),
      countReadyByAccount: jest.fn(async () => new Map([['a1', 5]])),
    };
    const replicaTargets = {
      resolve: jest.fn(async () => ({ effectiveTarget: 2 })),
      // 可调度账号复用权威资格判定（与下载分流、审计报告同一口径）
      evaluateEligibility: jest.fn(() => [
        { accountId: 'a1', eligible: true, reasons: [] },
        { accountId: 'a2', eligible: false, reasons: ['冷却中'] },
      ]),
    };
    const ctx = makeService(snapshot(), { copies, replicaTargets });

    await ctx.service.runOnce();
    expect(copies.replicationCoverageBySize).toHaveBeenCalledTimes(1);
    const first = ctx.alertEngine.createAlerts.mock.calls[0][0];
    expect(first.map((item) => item.ruleId)).toContain('LARGE_FILE_COVERAGE_DEGRADED');
    // 告警里的「可调度账号」必须与界面口径一致（复用资格判定，不自己拼条件）
    expect(first.find((item) => item.ruleId === 'LARGE_FILE_COVERAGE_DEGRADED')?.message)
      .toContain('可调度账号 1 个');

    // 第二个 tick 仍在节流窗口内：不再跑分组查询，也不重复告警
    await ctx.service.runOnce();
    expect(copies.replicationCoverageBySize).toHaveBeenCalledTimes(1);
    expect(ctx.alertEngine.createAlerts).toHaveBeenCalledTimes(1);
  });

  it('覆盖率采集抛错时只记日志：其余状态告警照常评估', async () => {
    const copies = {
      replicationCoverageBySize: jest.fn(async () => {
        throw new Error('db locked');
      }),
      countReadyByAccount: jest.fn(),
    };
    const replicaTargets = { resolve: jest.fn(async () => ({ effectiveTarget: 2 })) };
    const ctx = makeService(
      snapshot({ accounts: [{ id: 'a1', enabled: false, coolingDown: false, cooldownRemainingMs: 0 }] }),
      { copies, replicaTargets },
    );

    await ctx.service.runOnce();

    const created = ctx.alertEngine.createAlerts.mock.calls[0][0];
    expect(created.map((item) => item.ruleId)).toContain('BOT_POOL_ALL_UNAVAILABLE');
    expect(created.map((item) => item.ruleId)).not.toContain('LARGE_FILE_COVERAGE_DEGRADED');
  });

  it('告警引擎未装配时只记日志，不抛异常影响主链路', async () => {
    const ctx = makeService(
      snapshot({ accounts: [{ id: 'a1', enabled: false, coolingDown: false, cooldownRemainingMs: 0 }] }),
      { withEngine: false },
    );

    await expect(ctx.service.runOnce()).resolves.toBeUndefined();
  });
});
