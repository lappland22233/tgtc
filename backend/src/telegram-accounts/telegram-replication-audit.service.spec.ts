import { TelegramReplicationAuditService } from './telegram-replication-audit.service';

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

  const service = new TelegramReplicationAuditService(
    pool as never,
    copies as never,
    replicaTargets as never,
    configCache as never,
    capacity as never,
  );
  return { service, pool, copies, replicaTargets, configCache };
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
});
