import {
  CAPACITY_DOWN_STABLE_CYCLES,
  CAPACITY_EVAL_INTERVAL_MS,
  CAPACITY_FAILURE_FREEZE_THRESHOLD,
  CAPACITY_STEP_MAX,
  CAPACITY_UP_STABLE_CYCLES,
  DownloadCapacityPolicyService,
  targetUpstreamBudget,
} from './download-capacity-policy.service';

/** 构造账号池账号快照条目（只填预算策略关心的字段） */
function account(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    tokenPreview: `${id}…`,
    chatId: '-1001',
    enabled: true,
    weight: 1,
    maxInflight: 8,
    inflight: 0,
    bandwidthMbps: 0,
    successRate: 1,
    latencyMs: 0,
    coolingDown: false,
    cooldownRemainingMs: 0,
    consecutiveFailures: 0,
    totalRequests: 0,
    failures: 0,
    totalBytes: 0,
    lastErrorKind: null,
    primary: false,
    storageConfigured: true,
    ...overrides,
  };
}

function setup(options: {
  accounts?: ReturnType<typeof account>[];
  eligible?: string[];
  readyCounts?: Record<string, number>;
  currentBudget?: string;
  autoEnabled?: string;
  poolActive?: boolean;
  streamFailures?: number;
}) {
  const accounts = options.accounts ?? [account('a1')];
  const countersSnapshot = jest.fn(() => ({ streamFailures: options.streamFailures ?? 0 } as never));
  const pool = {
    isActive: () => options.poolActive ?? true,
    snapshot: () => ({ enabled: true, inactiveReason: null, counters: {} as never, accounts: accounts as never[] }),
    countersSnapshot,
  };
  const eligibleIds = options.eligible ?? accounts.map((item) => item.id);
  const replicaTargets = {
    evaluateEligibility: () => accounts.map((item) => ({
      accountId: item.id,
      eligible: eligibleIds.includes(item.id),
      reasons: eligibleIds.includes(item.id) ? [] : ['测试排除'],
    })),
  };
  const copies = {
    countReadyByAccount: jest.fn(async () =>
      new Map(Object.entries(options.readyCounts ?? Object.fromEntries(eligibleIds.map((id) => [id, 1]))))),
  };
  // 模拟 ConfigCacheService：set 之后 get 能读到新值（否则无法验证灰度与滞后）
  const store = new Map<string, string>();
  if (options.currentBudget !== undefined) store.set('FILE_DOWNLOAD_MAX_CONCURRENT_UPSTREAMS', options.currentBudget);
  if (options.autoEnabled !== undefined) store.set('FILE_DOWNLOAD_AUTO_CAPACITY_ENABLED', options.autoEnabled);
  const configCache = {
    get: jest.fn(async (key: string, fallback: string) => store.get(key) ?? fallback),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
  const audit = { log: jest.fn() };

  const service = new DownloadCapacityPolicyService(
    pool as never,
    copies as never,
    replicaTargets as never,
    configCache as never,
    audit as never,
  );
  return { service, pool, countersSnapshot, copies, replicaTargets, configCache, audit };
}

/** 连续评估 n 次 */
async function evaluateTimes(service: DownloadCapacityPolicyService, n: number) {
  let state = service.getState();
  for (let i = 0; i < n; i += 1) state = await service.evaluate();
  return state;
}

describe('targetUpstreamBudget（容量映射）', () => {
  it('min(64, max(8, n×8))：1 个 → 8，2 个 → 16，4 个 → 32，超过 8 封顶 64', () => {
    expect(targetUpstreamBudget(0)).toBe(8);
    expect(targetUpstreamBudget(1)).toBe(8);
    expect(targetUpstreamBudget(2)).toBe(16);
    expect(targetUpstreamBudget(3)).toBe(24);
    expect(targetUpstreamBudget(4)).toBe(32);
    expect(targetUpstreamBudget(8)).toBe(64);
    expect(targetUpstreamBudget(20)).toBe(64);
  });
});

describe('DownloadCapacityPolicyService（自动扩缩容闸门）', () => {
  it('升档需目标稳定 2 个周期，且每次最多 +8（灰度）', async () => {
    const ctx = setup({
      currentBudget: '16',
      accounts: [account('a1'), account('a2'), account('a3'), account('a4')],
    });

    const first = await ctx.service.evaluate();
    expect(first.targetBudget).toBe(32);
    expect(first.pendingUpCycles).toBe(CAPACITY_UP_STABLE_CYCLES - 1);
    expect(ctx.configCache.set).not.toHaveBeenCalled();

    await ctx.service.evaluate();
    expect(ctx.configCache.set).toHaveBeenCalledWith(
      'FILE_DOWNLOAD_MAX_CONCURRENT_UPSTREAMS',
      String(16 + CAPACITY_STEP_MAX),
      expect.any(String),
    );

    // 灰度：下一次仍只允许 +8，直到抵达目标 32
    await evaluateTimes(ctx.service, 2);
    expect(ctx.service.getState().currentBudget).toBe(32);
    expect(ctx.service.getState().lastChange).toMatchObject({ from: 24, to: 32, activeBotCount: 4 });

    // 审计记录必须包含旧值/新值/有效 Bot 数/来源
    expect(ctx.audit.log).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'FILE_DOWNLOAD_MAX_CONCURRENT_UPSTREAMS',
      metadata: expect.objectContaining({ oldValue: 24, newValue: 32, activeBotCount: 4, source: 'auto-capacity-policy' }),
    }));
  });

  it('采样窗口内新增上游失败达到阈值时冻结升档（即时评估不稀释窗口）', async () => {
    jest.useFakeTimers();
    try {
      const ctx = setup({
        currentBudget: '16',
        accounts: [account('a1'), account('a2')],
        streamFailures: 0,
      });
      await ctx.service.evaluate();

      // 窗口未推进时的即时评估（例如配置变更触发）不应消费掉失败增量
      ctx.countersSnapshot.mockReturnValue({ streamFailures: CAPACITY_FAILURE_FREEZE_THRESHOLD } as never);
      const immediate = await ctx.service.evaluate();
      expect(immediate.frozenReason).toBeNull();

      // 推进一个采样窗口后失败激增 → 冻结
      jest.advanceTimersByTime(CAPACITY_EVAL_INTERVAL_MS);
      const second = await ctx.service.evaluate();

      expect(second.frozenReason).toContain('新增回源失败');
      expect(ctx.configCache.set).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('存在限流冷却账号时冻结升档', async () => {
    const ctx = setup({
      currentBudget: '8',
      accounts: [account('a1'), account('a2', { coolingDown: true, lastErrorKind: 'flood' })],
    });
    await ctx.service.evaluate();
    const second = await ctx.service.evaluate();

    expect(second.frozenReason).toContain('限流冷却');
    expect(ctx.configCache.set).not.toHaveBeenCalled();
  });

  it('降档需持续 10 个周期、每次最多 -8、永不低于 8', async () => {
    const ctx = setup({ currentBudget: '64', accounts: [account('a1')] });

    const early = await evaluateTimes(ctx.service, CAPACITY_DOWN_STABLE_CYCLES - 1);
    expect(early.targetBudget).toBe(8);
    expect(ctx.configCache.set).not.toHaveBeenCalled();

    await ctx.service.evaluate();
    // 单次降幅 ≤8（不直接把 64 跳到 8）
    expect(ctx.configCache.set).toHaveBeenCalledWith(
      'FILE_DOWNLOAD_MAX_CONCURRENT_UPSTREAMS',
      String(64 - CAPACITY_STEP_MAX),
      expect.any(String),
    );
    expect(ctx.service.getState().lastChange).toMatchObject({ from: 64, to: 56 });

    // 继续降到下限后不再下降
    await evaluateTimes(ctx.service, CAPACITY_DOWN_STABLE_CYCLES * 12);
    expect(ctx.service.getState().currentBudget).toBe(8);
  });

  it('没有可实际回源的有效 Bot 时挂起自动调整（无依据不缩容）', async () => {
    const ctx = setup({
      currentBudget: '32',
      accounts: [account('a1')],
      eligible: ['a1'],
      readyCounts: {},
    });

    const state = await ctx.service.evaluate();

    expect(state.activeBotCount).toBe(0);
    expect(state.suspendedReason).toContain('没有可实际回源的有效 Bot');
    expect(ctx.configCache.set).not.toHaveBeenCalled();
    // 未满足「携带 ready 副本」的账号不计入有效 Bot
    expect(state.eligibleCount).toBe(1);
  });

  it('开关关闭时挂起且不写入', async () => {
    const ctx = setup({ currentBudget: '8', accounts: [account('a1'), account('a2')], autoEnabled: 'false' });

    const state = await ctx.service.evaluate();

    expect(state.enabled).toBe(false);
    expect(state.suspendedReason).toContain('开关已关闭');
    expect(ctx.configCache.set).not.toHaveBeenCalled();
  });

  it('目标等于当前预算时不写入（快照仍反映目标与有效 Bot 数）', async () => {
    const ctx = setup({ currentBudget: '16', accounts: [account('a1'), account('a2')] });

    const state = await evaluateTimes(ctx.service, 3);

    expect(state.currentBudget).toBe(16);
    expect(state.targetBudget).toBe(16);
    expect(state.activeBotCount).toBe(2);
    expect(ctx.configCache.set).not.toHaveBeenCalled();
    expect(state.lastChange).toBeNull();
  });

  it('ensureTimer 幂等装配（重复调用只注册一个定时器）', () => {
    const ctx = setup({});
    const spy = jest.spyOn(global, 'setInterval').mockImplementation(
      (() => ({ unref: () => undefined }) as unknown as NodeJS.Timeout) as unknown as typeof setInterval,
    );
    try {
      ctx.service.ensureTimer();
      ctx.service.ensureTimer();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      ctx.service.onApplicationShutdown();
    }
  });
});
