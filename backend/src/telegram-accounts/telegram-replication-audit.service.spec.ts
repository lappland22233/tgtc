import { TelegramReplicationAuditService } from './telegram-replication-audit.service';

/** 松散的替身类型：每个用例只提供自己关心的那部分方法 */
type Stub = Record<string, jest.Mock>;

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
  effectiveTarget?: number;
  poolActive?: boolean;
  coverage?: unknown;
  sizeCoverage?: unknown;
  capacity?: unknown;
  attempts?: Stub | null;
  capability?: Stub | null;
} = {}) {
  const accounts = options.accounts ?? [account('a1'), account('a2')];
  const eligibleIds = options.eligible ?? accounts.map((item) => item.id);
  const eligibility = accounts.map((item) => ({
    accountId: item.id,
    eligible: eligibleIds.includes(item.id),
    reasons: eligibleIds.includes(item.id) ? [] : ['未配置存储 Chat'],
  }));

  const pool = {
    isActive: () => options.poolActive ?? true,
    snapshot: () => ({ enabled: true, inactiveReason: null, counters: {} as never, accounts: accounts as never[] }),
  };
  const copies = {
    countReadyByAccount: jest.fn(async () => new Map(Object.entries(options.readyCounts ?? { a1: 8, a2: 3 }))),
    /** 手动重试入口（只走中继；本替身只断言调用形状） */
    ensureCopies: jest.fn(async () => ({
      status: 'succeeded' as const,
      created: [],
      missing: [],
      relayed: false,
    })),
    replicationCoverage: jest.fn(async () => options.coverage ?? {
      scannedFiles: 3,
      satisfied: 2,
      unsatisfied: 1,
      truncated: false,
      missingSamples: [{ ownerId: 'file-9', readyAccountCount: 0, missing: 2 }],
    }),
    /**
     * 按大小分层的覆盖率：默认返回「有一个 ≥4GiB 分卷仅被 1 个账号持有」，
     * 这正是生产事故的形状（4GB 分卷副本集中，单账号独扛 DC-5 回源）。
     */
    replicationCoverageBySize: jest.fn(async () => options.sizeCoverage ?? {
      scannedFiles: 2,
      truncated: false,
      tiers: [
        {
          label: '≥4GiB',
          minBytes: 4 * 1024 ** 3,
          files: 1,
          satisfied: 0,
          unsatisfied: 1,
          readyAccountCounts: [1],
          missingSamples: [{ ownerId: 'UNIQ-BIG', readyAccountCount: 1, missing: 1 }],
        },
        {
          label: '1–4GiB',
          minBytes: 1024 ** 3,
          files: 1,
          satisfied: 1,
          unsatisfied: 0,
          readyAccountCounts: [2],
          missingSamples: [],
        },
      ],
    }),
  };
  const replicaTargets = {
    resolve: jest.fn(async () => ({
      configured: 4,
      configuredSource: 'system' as const,
      eligibleCount: eligibleIds.length,
      effectiveTarget: options.effectiveTarget ?? eligibleIds.length,
      degradedReason: eligibleIds.length < 4 ? '可承载副本的账号数低于配置目标' : null,
      eligibleAccountIds: eligibleIds,
      eligibility,
    })),
  };
  const configCache = { set: jest.fn(async () => undefined) };
  const capacity = options.capacity === undefined
    ? { getState: () => ({ enabled: true, currentBudget: 16, targetBudget: 16, activeBotCount: 2 }) }
    : options.capacity;

  /** 扩散轮次替身：指标与时间线都来自持久化表（不是进程内计数） */
  const attempts = options.attempts === undefined
    ? {
        computeMetrics: jest.fn(async () => ({
          windowMs: 86_400_000,
          since: '2026-09-23T00:00:00.000Z',
          attempts: 6,
          relaySucceeded: 4,
          relayFailed: 1,
          blocked: 1,
          succeeded: 2,
          partialSuccess: 1,
          claimTimeouts: 1,
          relaySuccessRate: 0.8,
          claimRate: 0.75,
          relayDurationP50Ms: 1200,
          relayDurationP95Ms: 3000,
          claimDurationP50Ms: 500,
          claimDurationP95Ms: 900,
          failureReasons: [{ reason: 'network' as const, count: 1 }],
          bytesRelayed: 0 as const,
          sampleSufficient: true,
          truncated: false,
        })),
        getObservability: jest.fn(() => ({ degraded: false, reason: null, since: null, writeFailures: 0 })),
        listRecent: jest.fn(async () => ({
          items: [attemptRow('att-1')],
          truncated: false,
        })),
        listRecentFiltered: jest.fn(),
        getDetail: jest.fn(async () => ({ id: 'att-1', status: 'claim_timeout', retryable: true })),
        findById: jest.fn(async () => attemptRow('att-1')),
      }
    : options.attempts;
  const capability = options.capability === undefined
    ? {
        refreshFacts: jest.fn(async () => undefined),
        snapshot: jest.fn(() => ({
          relayEnabledByConfig: true,
          userClientAvailable: true,
          userClientUnavailableReason: null,
          enabledAuthorizedUserCount: 1,
          resolvedTargetChatIdPreview: '***0222',
          sourceChatIdPreview: '***0111',
          sourceChatReadable: 'ok' as const,
          targetChatWritable: 'not_checked' as const,
          botsCanReceiveRelay: 'ok' as const,
          checkedAt: '2026-09-24T00:00:00.000Z',
          checkStatus: 'partial' as const,
          notes: [],
        })),
        preflight: jest.fn(async () => ({ dryRun: true, status: 'ok', checks: [], sentTestMessage: false })),
      }
    : options.capability;

  const service = new TelegramReplicationAuditService(
    pool as never,
    copies as never,
    replicaTargets as never,
    configCache as never,
    capacity as never,
    attempts as never,
    capability as never,
  );
  // 返回时统一按非空替身标注：`null` 只用于「故意不装配」的用例，那些用例不会访问替身方法
  return {
    service,
    pool,
    copies,
    replicaTargets,
    configCache,
    attempts: attempts as Stub,
    capability: capability as Stub,
  };
}

/** 轮次行（时间线视图的输入形状） */
function attemptRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ownerType: 'fileUnique' as const,
    ownerId: 'UNIQ-BIG-ABCDEFGH',
    status: 'claim_timeout' as const,
    failureReason: 'unknown' as const,
    failureSummary: '中继转发成功但认领窗口内没有新增 ready 副本',
    retryCount: 1,
    desiredCount: 2,
    baselineReadyCount: 1,
    missingCount: 1,
    claimedAccountIds: ['a1'],
    relayAccountId: 'user-1',
    targetChatId: '-100222',
    triggeredBy: 'lazy' as const,
    startedAt: new Date('2026-09-24T00:00:00.000Z'),
    createdAt: new Date('2026-09-24T00:00:00.000Z'),
    relayCompletedAt: new Date('2026-09-24T00:00:02.000Z'),
    completedAt: new Date('2026-09-24T00:00:14.000Z'),
    nextRetryAt: new Date('2026-09-24T00:00:44.000Z'),
    ...overrides,
  };
}

describe('TelegramReplicationAuditService', () => {
  it('报告包含目标解析、逐账号资格（含 ready 副本数）与覆盖率', async () => {
    const ctx = setup({
      accounts: [
        account('a1'),
        account('a2'),
        account('a3', { storageConfigured: false }),
        account('a4', { coolingDown: true }),
      ],
      eligible: ['a1', 'a2'],
      readyCounts: { a1: 8, a2: 3 },
    });

    const report = await ctx.service.getReport();

    expect(report.target).toMatchObject({
      configured: 4,
      eligibleCount: 2,
      effectiveTarget: 2,
      allowedRange: { min: 1, max: 8 },
    });
    expect(report.target.degradedReason).toContain('低于配置目标');

    const byId = new Map(report.accounts.map((item) => [item.accountId, item]));
    expect(byId.get('a1')).toMatchObject({ readyCopies: 8, eligible: true, reasons: [] });
    expect(byId.get('a2')?.readyCopies).toBe(3);
    expect(byId.get('a3')).toMatchObject({ storageConfigured: false, eligible: false });
    expect(byId.get('a4')).toMatchObject({ coolingDown: true, eligible: false });
    // 无 storage Chat 的 a3 不在 eligible 集合内（资格由解析器统一判定）
    expect(byId.get('a3')?.reasons).toContain('未配置存储 Chat');

    expect(report.coverage).toMatchObject({ scannedFiles: 3, satisfied: 2, unsatisfied: 1 });
    expect(report.coverage.missingSamples).toEqual([{ ownerId: 'file-9', readyAccountCount: 0, missing: 2 }]);
    expect(report.capacity).toMatchObject({ currentBudget: 16 });
    expect(report.notes.join()).toContain('USERbot');
    // 覆盖率按 effectiveTarget 作为比较目标
    expect(ctx.copies.replicationCoverage).toHaveBeenCalledWith(expect.objectContaining({ ownerType: 'file', target: 2 }));

    // Bot 直链命名空间（fileUnique）必须**单独统计**：
    // 生产事故正发生在该命名空间（4GB 分卷副本集中在单一账号），
    // 历史实现只统计 file，导致问题在管理端完全不可见。
    expect(ctx.copies.replicationCoverage).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: 'fileUnique', target: 2 }),
    );
    expect(report.botCoverage).toMatchObject({ scannedFiles: 3, satisfied: 2 });

    // 按大小分层：≥4GiB 档必须能读出「仅 1 个账号持有」这一关键事实
    const bigTier = report.botSizeCoverage.tiers.find((tier) => tier.label === '≥4GiB');
    expect(bigTier).toMatchObject({ files: 1, satisfied: 0, unsatisfied: 1, minReadyAccounts: 1 });
    expect(bigTier?.readyAccountCounts).toEqual([1]);
    expect(report.sizeCoverage.tiers.length).toBeGreaterThan(0);
    expect(ctx.service.getReport()).resolves.toBeDefined();
  });

  it('分层覆盖率统计失败时返回空结构且报告仍可用（绝不抛给管理端）', async () => {
    const ctx = setup();
    ctx.copies.replicationCoverageBySize.mockRejectedValue(new Error('db down') as never);

    const report = await ctx.service.getReport();

    expect(report.botSizeCoverage).toMatchObject({ scannedFiles: 0, tiers: [] });
    expect(report.sizeCoverage.tiers).toEqual([]);
    // 总覆盖率不受分层统计失败影响（两者独立降级）
    expect(report.botCoverage.scannedFiles).toBe(3);
  });

  it('账号池未生效时不查询副本表，只返回诊断数据', async () => {
    const ctx = setup({ poolActive: false });

    const report = await ctx.service.getReport();

    expect(report.poolActive).toBe(false);
    expect(ctx.copies.countReadyByAccount).not.toHaveBeenCalled();
    expect(ctx.copies.replicationCoverage).not.toHaveBeenCalled();
    expect(ctx.copies.replicationCoverageBySize).not.toHaveBeenCalled();
    expect(report.coverage.scannedFiles).toBe(0);
    expect(report.botCoverage.scannedFiles).toBe(0);
    expect(report.botSizeCoverage.tiers).toEqual([]);
    expect(report.accounts.every((item) => item.readyCopies === 0)).toBe(true);
  });

  it('未装配容量策略时 capacity 为 null（报告仍可用）', async () => {
    const ctx = setup({ capacity: null });
    const report = await ctx.service.getReport();
    expect(report.capacity).toBeNull();
  });

  it('目标热更新写入 SystemConfig 并返回解析后的有效目标', async () => {
    const ctx = setup({ eligible: ['a1'] });

    const target = await ctx.service.setTarget(3);

    expect(ctx.configCache.set).toHaveBeenCalledWith(
      'TELEGRAM_POOL_TARGET_REPLICAS',
      '3',
      expect.any(String),
    );
    expect(target.configured).toBe(4); // 由解析器返回（mock 固定值）
  });

  it('越界的期望副本数被拒绝（1-8）', async () => {
    const ctx = setup();
    await expect(ctx.service.setTarget(0)).rejects.toThrow('期望副本数应在 1-8 之间');
    await expect(ctx.service.setTarget(9)).rejects.toThrow('期望副本数应在 1-8 之间');
    expect(ctx.configCache.set).not.toHaveBeenCalled();
  });

  // ---------------- 策略 B 可观测面（策略卡 / 指标卡 / 大文件覆盖 / 时间线） ----------------

  it('策略声明：仅用户账号中继、策略 A 已移除、不可能发生字节二次传输', async () => {
    const ctx = setup();

    const report = await ctx.service.getReport();

    expect(report.strategy).toMatchObject({
      mode: 'user_relay_only',
      label: '仅用户账号中继',
      strategyARemoved: true,
      byteReplicationPossible: false,
      relayEnabledByConfig: true,
      restartRequiredForToggle: true,
    });
    // 能力快照必须原样透出（含 not_checked，前端据此区分三态而不是伪造健康态）
    expect(report.strategy.capability).toMatchObject({
      enabledAuthorizedUserCount: 1,
      resolvedTargetChatIdPreview: '***0222',
      targetChatWritable: 'not_checked',
      checkStatus: 'partial',
    });
    expect(ctx.capability.refreshFacts).toHaveBeenCalled();
  });

  it('中继指标来自持久化轮次表，且契约常量 bytesRelayed 恒为 0', async () => {
    const ctx = setup();

    const report = await ctx.service.getReport();

    expect(report.relayMetrics).toMatchObject({
      attempts: 6,
      relaySucceeded: 4,
      relayFailed: 1,
      claimTimeouts: 1,
      relaySuccessRate: 0.8,
      claimRate: 0.75,
      bytesRelayed: 0,
      sampleSufficient: true,
    });
    expect(report.relayMetrics.failureReasons).toEqual([{ reason: 'network', count: 1 }]);
    expect(ctx.attempts.computeMetrics).toHaveBeenCalled();
  });

  it('观测降级时报告显式标记，前端可提示「观测数据不完整」', async () => {
    const ctx = setup({
      attempts: {
        computeMetrics: jest.fn(async () => ({ attempts: 0, bytesRelayed: 0 as const })),
        getObservability: jest.fn(() => ({
          degraded: true,
          reason: '统计扩散指标失败：db is down',
          since: '2026-09-24T00:00:00.000Z',
          writeFailures: 3,
        })),
        listRecent: jest.fn(async () => ({ items: [], truncated: false })),
      },
    });

    const report = await ctx.service.getReport();

    expect(report.observability.degraded).toBe(true);
    expect(report.observability.reason).toContain('db is down');
    expect(report.observability.writeFailures).toBe(3);
  });

  it('大文件覆盖：≥4GiB 提为主视图、1–4GiB 作对照，并区分「已登记」与「可调度」', async () => {
    const ctx = setup({
      accounts: [account('a1'), account('a2'), account('a3', { coolingDown: true })],
      eligible: ['a1', 'a2'],
      readyCounts: { a1: 8, a2: 3 },
    });

    const report = await ctx.service.getReport();

    expect(report.largeFileCoverage.ownerType).toBe('fileUnique');
    expect(report.largeFileCoverage.primary).toMatchObject({
      label: '≥4GiB',
      files: 1,
      satisfied: 0,
      unsatisfied: 1,
      readyAccountCounts: [1],
    });
    expect(report.largeFileCoverage.secondary).toMatchObject({ label: '1–4GiB', files: 1, satisfied: 1 });
    // 「副本已登记」是历史事实，「当前可调度」才是分流能力——两者必须并列，不能混为一谈
    expect(report.largeFileCoverage.readyAccounts).toBe(2);
    expect(report.largeFileCoverage.schedulableAccounts).toBe(2);
  });

  it('大文件分层缺失时不伪造空档（primary/secondary 为 null）', async () => {
    const ctx = setup({ sizeCoverage: { scannedFiles: 0, truncated: false, tiers: [] } });

    const report = await ctx.service.getReport();

    expect(report.largeFileCoverage.primary).toBeNull();
    expect(report.largeFileCoverage.secondary).toBeNull();
    expect(report.largeFileCoverage.scannedFiles).toBe(0);
  });

  it('缺失样例的 ownerId 一律脱敏（fileUnique 下即完整 file_unique_id）', async () => {
    const longId = 'UNIQ-abcdef0123456789abcdef0123456789';
    const ctx = setup({
      sizeCoverage: {
        scannedFiles: 1,
        truncated: false,
        tiers: [{
          label: '≥4GiB',
          minBytes: 4 * 1024 ** 3,
          files: 1,
          satisfied: 0,
          unsatisfied: 1,
          readyAccountCounts: [1],
          missingSamples: [{ ownerId: longId, readyAccountCount: 1, missing: 1 }],
        }],
      },
    });

    const report = await ctx.service.getReport();

    // 大文件分层的样例来自 fileUnique 命名空间：必须脱敏，且不能出现在响应任何位置
    const samples = report.largeFileCoverage.primary?.missingSamples ?? [];
    expect(samples).toHaveLength(1);
    expect(samples[0].ownerId).toBe(`${longId.slice(0, 8)}…`);
    expect(JSON.stringify(report)).not.toContain(longId);
    // 站内 `file` 命名空间的样例保留可读 id（内部 UUID，不含 Telegram 标识）
    expect(report.coverage.missingSamples[0].ownerId).toBe('file-9');
  });

  it('覆盖率统计失败时显式降级，不伪装成「0/0 全零健康态」', async () => {
    const ctx = setup({
      coverage: undefined,
      sizeCoverage: undefined,
    });
    // 让四个覆盖率查询全部抛错（统计失败）
    ctx.copies.replicationCoverage.mockRejectedValue(new Error('db is locked'));
    ctx.copies.replicationCoverageBySize.mockRejectedValue(new Error('db is locked'));

    const report = await ctx.service.getReport();

    expect(report.observability.degraded).toBe(true);
    expect(report.observability.reason).toContain('db is locked');
    // 统计失败时仍返回可渲染的空结构（但已带降级标记）
    expect(report.coverage.scannedFiles).toBe(0);
  });

  it('观测服务未装配时列表与报告都标记降级（「看不到」不等于「健康」）', async () => {
    const ctx = setup({ attempts: null });

    const report = await ctx.service.getReport();
    const list = await ctx.service.listAttempts({});

    expect(report.observability.degraded).toBe(true);
    expect(report.observability.reason).toContain('未装配');
    expect(list.observability.degraded).toBe(true);
  });

  it('最近事件视图脱敏并派生耗时与可重试性', async () => {
    const ctx = setup();

    const report = await ctx.service.getReport();

    const item = report.recentAttempts[0];
    expect(item.statusLabel).toBe('认领超时');
    expect(item.failureReasonLabel).toBe('未知错误');
    expect(item.retryable).toBe(true);
    // 中继耗时 2s、认领耗时 12s（时间线可重建）
    expect(item.relayDurationMs).toBe(2000);
    expect(item.claimDurationMs).toBe(12_000);
    // 脱敏：不返回完整 file_unique_id 与完整 chat id
    expect(item.ownerLabel).toBe('UNIQ-BIG…');
    expect(item.targetChatPreview).toBe('***0222');
    expect(JSON.stringify(report.recentAttempts)).not.toContain('-100222');
  });

  it('轮次列表查询支持筛选并透出观测状态', async () => {
    const ctx = setup();

    const list = await ctx.service.listAttempts({ status: 'claim_timeout', limit: 10 });

    expect(ctx.attempts.listRecent).toHaveBeenCalledWith({ status: 'claim_timeout', limit: 10 });
    expect(list.items).toHaveLength(1);
    expect(list.truncated).toBe(false);
    expect(list.observability.degraded).toBe(false);
  });

  it('手动重试只对可重试状态开放，配置类阻塞直接拒绝', async () => {
    const blocked = setup({
      attempts: {
        findById: jest.fn(async () => attemptRow('att-blocked', { status: 'blocked_not_configured' })),
      },
    });
    const blockedRetry = jest.fn();
    blocked.service.registerDiffusionRetryHandler(blockedRetry);
    await expect(blocked.service.retryAttempt('att-blocked', 'admin-1'))
      .rejects.toThrow('不支持重试');
    expect(blockedRetry).not.toHaveBeenCalled();

    const missing = setup({ attempts: { findById: jest.fn(async () => null) } });
    missing.service.registerDiffusionRetryHandler(jest.fn());
    await expect(missing.service.retryAttempt('att-missing', 'admin-1'))
      .rejects.toThrow('不存在或已被保留期清理');
  });

  it('镜像模块未装配时手动重试明确报错，不静默什么都不做', async () => {
    const ctx = setup();
    await expect(ctx.service.retryAttempt('att-1', 'admin-1'))
      .rejects.toThrow('镜像模块未装配');
  });

  it('手动重试委托镜像任务队列：按目标群限定范围并记录操作人', async () => {
    const ctx = setup();
    const handler = jest.fn(async () => ({ requeued: 2, created: 1, ruleIds: ['rule-1', 'rule-2'] }));
    ctx.service.registerDiffusionRetryHandler(handler);

    const result = await ctx.service.retryAttempt('att-1', 'admin-9');

    expect(result).toEqual({
      attemptId: 'att-1',
      requeued: 2,
      created: 1,
      ruleIds: ['rule-1', 'rule-2'],
    });
    // 必须带上目标群：多镜像群各自独立轮次，不限定目标群会重排其它群的扩散
    expect(handler).toHaveBeenCalledWith({
      ownerType: 'fileUnique',
      ownerId: 'UNIQ-BIG-ABCDEFGH',
      targetChatId: '-100222',
      operatorUserId: 'admin-9',
    });
  });

  it('轮次记录缺目标群（历史数据）时拒绝重试：不按「全部启用规则」误重排其它镜像群', async () => {
    const ctx = setup({
      attempts: {
        findById: jest.fn(async () => attemptRow('att-legacy', { status: 'retryable_failed', targetChatId: null })),
      },
    });
    const handler = jest.fn();
    ctx.service.registerDiffusionRetryHandler(handler);

    await expect(ctx.service.retryAttempt('att-legacy', 'admin-1'))
      .rejects.toThrow('缺少镜像群信息');
    expect(handler).not.toHaveBeenCalled();
  });

  it('预检默认 dry-run，未装配能力服务时显式报错而不是返回空报告', async () => {
    const ctx = setup();
    const report = await ctx.service.runPreflight({});
    expect(ctx.capability.preflight).toHaveBeenCalledWith(expect.objectContaining({}));
    expect(report).toMatchObject({ dryRun: true, sentTestMessage: false });

    const withoutCapability = setup({ capability: null });
    await expect(withoutCapability.service.runPreflight({})).rejects.toThrow('能力服务未装配');
  });
});
