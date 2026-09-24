import { FileCopyService } from './file-copy.service';
import type { UserRelayResult } from './user-relay.service';

function makeRepo() {
  return {
    find: jest.fn(async (_options?: unknown): Promise<unknown[]> => []),
    findOne: jest.fn(async (_options?: unknown): Promise<unknown> => null),
    createQueryBuilder: jest.fn(),
    create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
    save: jest.fn(async (value: Record<string, unknown>) => ({ ...value, id: 'copy-1' })),
    update: jest.fn(async () => ({ affected: 1 })),
    delete: jest.fn(async (_where?: Record<string, unknown>) => ({ affected: 2 })),
  };
}

/** 账号池账号快照条目（只填副本资格判定关心的字段） */
function accountSnapshot(id: string, overrides: Record<string, unknown> = {}) {
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

function makePool() {
  return {
    ids: jest.fn(() => ['a1', 'a2']),
    storageAccountIds: jest.fn(() => ['a1', 'a2']),
    snapshot: jest.fn(() => ({
      enabled: true,
      inactiveReason: null,
      counters: {} as never,
      accounts: [accountSnapshot('a1'), accountSnapshot('a2')] as never[],
    })),
    getConfig: jest.fn((id: string) => (id === 'a1' || id === 'a2'
      ? { id, token: `${id}:SECRET`, chatId: '-1001', weight: 1, maxInflight: 8, enabled: true }
      : null)),
    select: jest.fn((candidates?: string[]) => (candidates?.length ? { accountId: candidates[0], score: 1, reason: 'test' } : null)),
    beginAttempt: jest.fn(() => true),
    releaseAttempt: jest.fn(),
    finishAttempt: jest.fn(),
    /** 原子准入替身：策略 B 不应再调用它（不占用任何 Bot 账号额度） */
    admit: jest.fn(),
    bumpCounter: jest.fn(),
  };
}

/** 中继替身：默认「已启用 + 目标群可用 + 转发成功」 */
function makeRelay(options: { enabled?: boolean; targetChatId?: string } = {}) {
  return {
    isEnabledByConfig: jest.fn(() => options.enabled ?? true),
    resolveTargetChatId: jest.fn(async () => options.targetChatId ?? '-100222'),
    relay: jest.fn(async (_request?: unknown): Promise<UserRelayResult> => (
      { ok: true, messageId: '9001', accountId: 'u1' }
    )),
  };
}

/** 轮次持久化替身：`settleClaims` 按与真实服务一致的口径推导状态 */
function makeAttempts(options: { skipped?: boolean } = {}) {
  return {
    beginRound: jest.fn(async () => ({
      attempt: { id: 'att-1' },
      merged: false,
      skipped: options.skipped ?? false,
    })),
    markRelayStarted: jest.fn(async () => undefined),
    markRelaySucceeded: jest.fn(async () => undefined),
    finishBlocked: jest.fn(async () => null),
    settleClaims: jest.fn(async (
      _id: string,
      params: { desiredCount: number; baselineReadyCount: number; readyAccountIds: string[] },
    ) => {
      const gained = Math.max(0, params.readyAccountIds.length - params.baselineReadyCount);
      if (gained === 0) return { status: 'claim_timeout' };
      return { status: params.readyAccountIds.length >= params.desiredCount ? 'succeeded' : 'partial_success' };
    }),
  };
}

function makeFilesRepo(ids: string[] = []) {
  return {
    find: jest.fn(async () => ids.map((id) => ({ id }))),
  };
}

/** 副本行工厂（ready 集合的最小形状） */
function copyRow(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `copy-${accountId}`,
    ownerType: 'fileUnique' as const,
    ownerId: 'UNIQ-1',
    accountId,
    telegramFileId: `${accountId}-file`,
    chatId: '-100999',
    messageId: '77',
    fileSize: '100',
    status: 'ready' as const,
    ...overrides,
  };
}

interface SetupOptions {
  /** 初始 ready 副本账号（按顺序） */
  ready?: string[];
  relayEnabled?: boolean;
  targetChatId?: string;
  /** 中继开关已开但源副本缺少 (chatId, messageId) 锚点 */
  anchorMissing?: boolean;
  attemptsSkipped?: boolean;
  /** 传入数组即装配逻辑文件仓库（桥接用）；传 null 表示未装配 */
  files?: string[] | null;
}

/**
 * 装配被测服务。
 *
 * `repo.find` 按 `where` 分流而不是按调用顺序：`readyAccountIds` / `listReady` / `planTargets`
 * 都从同一份可变 `ready` 集合读取，`findByAnchor`（带 `chatId`）单独分流——
 * 这样用例只需改状态，不必维护脆弱的调用次数假设。
 */
function setup(options: SetupOptions = {}) {
  const repo = makeRepo();
  const pool = makePool();
  const relay = makeRelay({ enabled: options.relayEnabled, targetChatId: options.targetChatId });
  const attempts = makeAttempts({ skipped: options.attemptsSkipped });
  const filesRepo = options.files === undefined ? null : makeFilesRepo(options.files ?? []);

  const anchorMissing = options.anchorMissing ?? false;
  const ready = (options.ready ?? []).map((accountId) => copyRow(accountId, {
    chatId: anchorMissing ? '' : '-100999',
    messageId: anchorMissing ? '' : '77',
  }));

  repo.find.mockImplementation(async (findOptions?: unknown) => {
    const where = (findOptions as { where?: Record<string, unknown> } | undefined)?.where ?? {};
    if ('chatId' in where) return [];
    return ready;
  });

  const service = new FileCopyService(
    repo as never,
    pool as never,
    relay as never,
    filesRepo as never,
    attempts as never,
  );
  return { service, repo, pool, relay, attempts, ready, filesRepo };
}

const ENSURE_PARAMS = {
  ownerType: 'fileUnique' as const,
  ownerId: 'UNIQ-1',
  fileName: 'f.bin',
  expectedSize: 100,
  desiredCount: 2,
};

describe('FileCopyService（副本登记 / 去重 / 生命周期清理）', () => {
  it('upsertReady 新建副本：写入逻辑主键、账号与该账号的 file_id', async () => {
    const ctx = setup();

    await ctx.service.upsertReady({
      ownerType: 'fileUnique',
      ownerId: 'UNIQ-1',
      accountId: 'a1',
      telegramFileId: 'a1-file',
      chatId: '7001',
      messageId: '100',
      fileSize: 1024,
      source: 'inbound',
    });

    expect(ctx.repo.create).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: 'fileUnique',
      ownerId: 'UNIQ-1',
      accountId: 'a1',
      telegramFileId: 'a1-file',
      fileSize: '1024',
      source: 'inbound',
      status: 'ready',
      lastError: null,
    }));
    expect(ctx.repo.save).toHaveBeenCalledTimes(1);
  });

  it('upsertReady 已存在时覆盖 file_id 并清空错误（重投幂等）', async () => {
    const ctx = setup();
    const existing = {
      id: 'copy-1',
      ownerType: 'fileUnique',
      ownerId: 'UNIQ-1',
      accountId: 'a1',
      telegramFileId: 'stale',
      chatId: '7001',
      messageId: '100',
      fileSize: '512',
      source: 'inbound',
      status: 'failed' as const,
      lastError: 'old error',
      lastUsedAt: null,
    };
    ctx.repo.findOne.mockResolvedValue(existing as never);

    await ctx.service.upsertReady({
      ownerType: 'fileUnique',
      ownerId: 'UNIQ-1',
      accountId: 'a1',
      telegramFileId: 'fresh',
      source: 'relayed',
    });

    expect(ctx.repo.create).not.toHaveBeenCalled();
    expect(ctx.repo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'copy-1',
      telegramFileId: 'fresh',
      source: 'relayed',
      status: 'ready',
      lastError: null,
    }));
  });

  it('findByAnchor 按 (chatId, messageId) 反查逻辑主键（读取多条以支持双写）', async () => {
    const ctx = setup();
    await ctx.service.findByAnchor('7001', '100');

    // 必须读取**多行**：桥接双写下同一锚点会同时存在 fileUnique 与 file 两种记录，
    // 只取一行会让候选集合随数据库返回顺序漂移
    expect(ctx.repo.find).toHaveBeenCalledWith(expect.objectContaining({
      where: { chatId: '7001', messageId: '100' },
    }));
  });

  it('findByAnchor 多义锚点：优先 fileUnique，结果稳定不随返回顺序漂移', async () => {
    const ctx = setup();
    // 桥接双写：同一锚点同时存在 file 与 fileUnique 两种记录（顺序刻意打乱）
    const fileRow = {
      id: 'c-file', ownerType: 'file' as const, ownerId: 'file-1', accountId: 'a1',
      telegramFileId: 'a1-file', chatId: '7001', messageId: '100',
    };
    const uniqueRow = {
      id: 'c-uniq', ownerType: 'fileUnique' as const, ownerId: 'UNIQ-1', accountId: 'a1',
      telegramFileId: 'a1-file', chatId: '7001', messageId: '100',
    };
    ctx.repo.find.mockResolvedValue([fileRow, uniqueRow] as never);

    const picked = await ctx.service.findByAnchor('7001', '100');
    expect(picked?.ownerType).toBe('fileUnique');
    expect(picked?.ownerId).toBe('UNIQ-1');

    // 数据库返回顺序颠倒时结果必须一致（否则回源候选集合会在命名空间之间漂移）
    ctx.repo.find.mockResolvedValue([uniqueRow, fileRow] as never);
    const pickedAgain = await ctx.service.findByAnchor('7001', '100');
    expect(pickedAgain?.ownerType).toBe('fileUnique');
    expect(pickedAgain?.ownerId).toBe('UNIQ-1');
    // 多义锚点被计数（供审计发现归属歧义）
    expect(ctx.service.anchorConflictCount).toBeGreaterThan(0);
  });

  it('findByAnchor 同优先级多义：按 ownerId 升序收敛（确定性）', async () => {
    const ctx = setup();
    ctx.repo.find.mockResolvedValue([
      { id: 'b', ownerType: 'fileUnique', ownerId: 'UNIQ-Z', accountId: 'a1', telegramFileId: 'f1' },
      { id: 'a', ownerType: 'fileUnique', ownerId: 'UNIQ-A', accountId: 'a2', telegramFileId: 'f2' },
    ] as never);

    const picked = await ctx.service.findByAnchor('7001', '100');
    expect(picked?.ownerId).toBe('UNIQ-A');
  });

  it('findByAnchor 单行命中时不产生冲突计数（正常路径无噪声）', async () => {
    const ctx = setup();
    ctx.repo.find.mockResolvedValue([
      { id: 'c1', ownerType: 'fileUnique', ownerId: 'UNIQ-1', accountId: 'a1', telegramFileId: 'f1' },
    ] as never);

    await ctx.service.findByAnchor('7001', '100');
    expect(ctx.service.anchorConflictCount).toBe(0);
  });

  it('purgeStale 按阈值分类清理并返回各类计数', async () => {
    const ctx = setup();
    ctx.repo.delete
      .mockResolvedValueOnce({ affected: 2 } as never)  // failed
      .mockResolvedValueOnce({ affected: 1 } as never)  // pending
      .mockResolvedValueOnce({ affected: 3 } as never)  // ready 已使用
      .mockResolvedValueOnce({ affected: 4 } as never); // ready 从未使用

    const result = await ctx.service.purgeStale({
      failedBefore: new Date('2026-09-20T00:00:00Z'),
      pendingBefore: new Date('2026-09-21T00:00:00Z'),
      staleReadyBefore: new Date('2026-08-22T00:00:00Z'),
    });

    expect(result).toEqual({ failed: 2, pending: 1, staleReadyUsed: 3, staleReadyUnused: 4 });
    expect(ctx.repo.delete).toHaveBeenCalledTimes(4);
    expect(ctx.repo.delete).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: 'failed' }));
    expect(ctx.repo.delete).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: 'pending' }));
    expect(ctx.repo.delete).toHaveBeenNthCalledWith(3, expect.objectContaining({ status: 'ready' }));
    // 第 4 条必须同时限定「从未使用」（lastUsedAt 为空），避免删掉近期活跃副本
    const unusedFilter = ctx.repo.delete.mock.calls[3][0]! as Record<string, unknown>;
    expect(unusedFilter.status).toBe('ready');
    expect(unusedFilter.createdAt).toBeDefined();
    expect(unusedFilter.lastUsedAt).toBeDefined();
  });

  it('无记录可清理时返回全 0（不误报）', async () => {
    const ctx = setup();
    ctx.repo.delete.mockResolvedValue({ affected: 0 } as never);

    const result = await ctx.service.purgeStale({
      failedBefore: new Date(),
      pendingBefore: new Date(),
      staleReadyBefore: new Date(),
    });

    expect(result).toEqual({ failed: 0, pending: 0, staleReadyUsed: 0, staleReadyUnused: 0 });
  });

  it('countReadyByAccount 按账号分组统计 ready 副本（审计与容量策略共用）', async () => {
    const ctx = setup();
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(async () => [
        { accountId: 'a1', count: '8' },
        { accountId: 'a2', count: '3' },
      ]),
    };
    ctx.repo.createQueryBuilder.mockReturnValue(qb as never);

    const counts = await ctx.service.countReadyByAccount('file');

    expect(counts.get('a1')).toBe(8);
    expect(counts.get('a2')).toBe(3);
    expect(qb.where).toHaveBeenCalledWith('copy.status = :status', { status: 'ready' });
    expect(qb.andWhere).toHaveBeenCalledWith('copy.ownerType = :ownerType', { ownerType: 'file' });
  });
});

/**
 * 策略 B fail-closed 状态机。
 *
 * 事故背景（本组用例保护的语义）：原实现把「用户账号中继」当作可选优化，
 * 中继不可用（开关未开 / 客户端缺失 / 无可用账号 / 目标群未配 / 源群不可读）时
 * **静默回退到「逐账号二次上传」**——N 个账号就是 N 次全量重传，与下载争抢同一
 * 账号额度，且中继失败在后台完全不可见。现在只有一条链路：中继不可用一律
 * 落成明确的阻塞/失败状态并按指数退避重试，**绝不发生文件字节的二次传输**。
 */
describe('FileCopyService（策略 B fail-closed 状态机）', () => {
  it('已达标文件直接返回 succeeded，且不写轮次（健康文件不制造无意义事件行）', async () => {
    const ctx = setup({ ready: ['a1', 'a2'] });

    const result = await ctx.service.ensureCopies(ENSURE_PARAMS);

    expect(result.status).toBe('succeeded');
    expect(result.created).toEqual([]);
    expect(result.relayed).toBe(false);
    expect(ctx.attempts.beginRound).not.toHaveBeenCalled();
    expect(ctx.relay.relay).not.toHaveBeenCalled();
  });

  it('中继成功且 Bot 立即认领到目标数 → succeeded，并回写认领账号', async () => {
    const ctx = setup({ ready: ['a1'] });
    ctx.relay.relay.mockImplementation(async () => {
      ctx.ready.push(copyRow('a2'));
      return { ok: true, messageId: '9001', accountId: 'u1' };
    });

    const result = await ctx.service.ensureCopies(ENSURE_PARAMS);

    expect(result.status).toBe('succeeded');
    expect(result.relayed).toBe(true);
    expect(result.created).toEqual(['a2']);
    expect(result.attemptId).toBe('att-1');
    expect(result.missing).toEqual([]);
    expect(ctx.attempts.markRelayStarted).toHaveBeenCalledWith('att-1');
    expect(ctx.attempts.markRelaySucceeded).toHaveBeenCalledWith('att-1', expect.objectContaining({
      relayAccountId: 'u1',
      relayMessageId: '9001',
    }));
    expect(ctx.attempts.settleClaims).toHaveBeenCalledWith('att-1', expect.objectContaining({
      desiredCount: 2,
      baselineReadyCount: 1,
      readyAccountIds: ['a1', 'a2'],
    }));
    // 轮次记录里的期望数与基线必须来自本轮真实缺口，而不是默认值
    expect(ctx.attempts.beginRound).toHaveBeenCalledWith(expect.objectContaining({
      desiredCount: 2,
      baselineReadyCount: 1,
      idempotencyKey: 'copy:fileUnique:UNIQ-1',
      targetChatId: '-100222',
    }));
  });

  it('中继成功但只认领到部分副本 → partial_success，缺口留在 missing', async () => {
    const ctx = setup({ ready: ['a1'] });
    ctx.relay.relay.mockImplementation(async () => {
      ctx.ready.push(copyRow('a2'));
      return { ok: true, messageId: '9001', accountId: 'u1' };
    });

    const result = await ctx.service.ensureCopies({ ...ENSURE_PARAMS, desiredCount: 3 });

    expect(result.status).toBe('partial_success');
    expect(result.created).toEqual(['a2']);
    expect(result.missing).toEqual([]);
  });

  it('中继成功但无人认领 → claim_timeout，并计入 relayClaimsMissed（不静默跳过）', async () => {
    jest.useFakeTimers();
    try {
      const ctx = setup({ ready: ['a1'] });

      const pending = ctx.service.ensureCopies(ENSURE_PARAMS);
      // 认领窗口内有界轮询：推进到窗口结束仍无新增副本
      await jest.advanceTimersByTimeAsync(12_500);
      const result = await pending;

      expect(result.status).toBe('claim_timeout');
      expect(result.relayed).toBe(true);
      expect(result.created).toEqual([]);
      expect(result.missing).toEqual(['a2']);
      expect(ctx.pool.bumpCounter).toHaveBeenCalledWith('relayClaimsMissed');
    } finally {
      jest.useRealTimers();
    }
  });

  it('中继开关未开启 → blocked_not_configured，且不发起任何中继调用', async () => {
    const ctx = setup({ ready: ['a1'], relayEnabled: false });

    const result = await ctx.service.ensureCopies(ENSURE_PARAMS);

    expect(result.status).toBe('blocked_not_configured');
    expect(result.failureReason).toBe('not_configured');
    expect(ctx.relay.relay).not.toHaveBeenCalled();
    expect(ctx.attempts.finishBlocked).toHaveBeenCalledWith('att-1', expect.objectContaining({
      status: 'blocked_not_configured',
      failureReason: 'not_configured',
      missingCount: 1,
    }));
  });

  it('没有启用中的镜像规则目标群 → blocked_target_chat（不再回退归档群）', async () => {
    const ctx = setup({ ready: ['a1'], targetChatId: '' });

    const result = await ctx.service.ensureCopies(ENSURE_PARAMS);

    expect(result.status).toBe('blocked_target_chat');
    expect(result.failureReason).toBe('target_missing');
    expect(ctx.relay.relay).not.toHaveBeenCalled();
  });

  it('源副本缺少 (chatId, messageId) 锚点 → blocked_source_anchor', async () => {
    const ctx = setup({ ready: ['a1'], anchorMissing: true });

    const result = await ctx.service.ensureCopies(ENSURE_PARAMS);

    expect(result.status).toBe('blocked_source_anchor');
    expect(result.failureReason).toBe('source_missing');
    expect(ctx.relay.relay).not.toHaveBeenCalled();
  });

  it('中继执行失败按原因分类：权限问题阻塞人工处理，网络问题可重试', async () => {
    const permission = setup({ ready: ['a1'] });
    permission.relay.relay.mockResolvedValue({
      ok: false, reason: 'permission_denied', detail: 'permission: CHAT_WRITE_FORBIDDEN',
    });
    const blocked = await permission.service.ensureCopies(ENSURE_PARAMS);
    expect(blocked.status).toBe('blocked_manual');
    expect(blocked.failureReason).toBe('permission_denied');
    expect(permission.attempts.finishBlocked).toHaveBeenCalledWith('att-1', expect.objectContaining({
      status: 'blocked_manual',
      failureSummary: 'permission: CHAT_WRITE_FORBIDDEN',
    }));

    const network = setup({ ready: ['a1'] });
    network.relay.relay.mockResolvedValue({ ok: false, reason: 'network', detail: 'network: 连接超时' });
    const retryable = await network.service.ensureCopies(ENSURE_PARAMS);
    expect(retryable.status).toBe('retryable_failed');
    expect(retryable.failureReason).toBe('network');
    expect(network.attempts.finishBlocked).toHaveBeenCalledWith('att-1', expect.objectContaining({
      status: 'retryable_failed',
    }));
  });

  it('退避窗口未到期时整轮跳过：不写行、不中继、不产生新副本', async () => {
    const ctx = setup({ ready: ['a1'], attemptsSkipped: true });

    const result = await ctx.service.ensureCopies(ENSURE_PARAMS);

    expect(result.skipped).toBe(true);
    expect(result.status).toBe('planned');
    expect(result.created).toEqual([]);
    expect(ctx.relay.relay).not.toHaveBeenCalled();
    expect(ctx.attempts.finishBlocked).not.toHaveBeenCalled();
  });

  it('同一文件的并发 ensureCopies 只执行一轮中继（single-flight）', async () => {
    const ctx = setup({ ready: ['a1'] });
    ctx.relay.relay.mockImplementation(async () => {
      ctx.ready.push(copyRow('a2'));
      return { ok: true, messageId: '9001', accountId: 'u1' };
    });

    const [first, second] = await Promise.all([
      ctx.service.ensureCopies(ENSURE_PARAMS),
      ctx.service.ensureCopies(ENSURE_PARAMS),
    ]);

    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    // 只发起一次中继（并发请求共享同一轮结果）
    expect(ctx.relay.relay).toHaveBeenCalledTimes(1);
    expect(ctx.attempts.beginRound).toHaveBeenCalledTimes(1);
  });

  it('扩散全过程不占用 Bot 账号额度、不发生任何字节传输', async () => {
    const ctx = setup({ ready: ['a1'] });
    ctx.relay.relay.mockImplementation(async () => {
      ctx.ready.push(copyRow('a2'));
      return { ok: true, messageId: '9001', accountId: 'u1' };
    });

    await ctx.service.ensureCopies(ENSURE_PARAMS);

    // 策略 A 的痕迹必须完全消失：准入（占用在飞/大文件槽位）与字节传输相关计数都不再被触碰
    expect(ctx.pool.admit).not.toHaveBeenCalled();
    expect(ctx.pool.select).not.toHaveBeenCalled();
    expect(ctx.pool.bumpCounter).not.toHaveBeenCalledWith('replicationsOk');
    expect(ctx.pool.bumpCounter).not.toHaveBeenCalledWith('replicationsFailed');
  });

  it('planTargets 是纯缺口计算：不产生任何副作用（策略 A 的 claim 占位已移除）', async () => {
    const ctx = setup({ ready: ['a1'] });

    const first = await ctx.service.planTargets('fileUnique', 'UNIQ-1', 2);
    const second = await ctx.service.planTargets('fileUnique', 'UNIQ-1', 2);

    expect(first).toEqual(['a2']);
    // 原 claim 表会让第二次调用看不到 a2（TTL 内占位）——移除后结果必须稳定一致
    expect(second).toEqual(['a2']);
    expect(ctx.pool.select).not.toHaveBeenCalled();
  });

  it('资格判定排除无存储 Chat / 冷却 / 满载 / 源账号 / 已持有，并给出可读原因', async () => {
    const ctx = setup();
    ctx.pool.snapshot.mockReturnValue({
      enabled: true,
      inactiveReason: null,
      counters: {} as never,
      accounts: [
        accountSnapshot('a1'),
        accountSnapshot('a2'),
        accountSnapshot('a3', { storageConfigured: false }),
        accountSnapshot('a4', { coolingDown: true, cooldownRemainingMs: 30_000 }),
        accountSnapshot('a5', { inflight: 8, maxInflight: 8 }),
      ] as never[],
    });

    const eligibility = ctx.service.evaluateTargetEligibility(['a2'], 'a1');
    const byId = new Map(eligibility.map((item) => [item.accountId, item]));
    expect(byId.get('a1')?.reasons.join()).toContain('源账号');
    expect(byId.get('a2')?.reasons.join()).toContain('已持有');
    expect(byId.get('a3')?.reasons.join()).toContain('存储 Chat');
    expect(byId.get('a4')?.reasons.join()).toContain('冷却');
    expect(byId.get('a5')?.reasons.join()).toContain('在飞上限');
  });
});

/**
 * 入站副本 → 站内文件桥接。
 *
 * 事故背景（本组用例保护的语义）：入站登记写 `ownerType='fileUnique'`，而站内下载只查
 * `ownerType='file'`；两侧不打通时，副本可见群里各 Bot 认领到的副本永远不会被下载选号消费，
 * 「让所有 Bot 都能获取副本实现负载均衡」形同虚设。
 */
describe('FileCopyService（入站副本桥接到站内逻辑文件）', () => {
  it('命中单个逻辑文件时写入 ownerType=file 副本，且只用该账号自己的 file_id', async () => {
    const files = makeFilesRepo(['file-1']);
    const ctx = setup({ files: ['file-1'] });

    const result = await ctx.service.bridgeInboundCopyToLogicalFile({
      fileUniqueId: 'UNIQ-abc',
      accountId: 'a2',
      telegramFileId: 'a2-own-file-id',
      chatId: '-100777',
      messageId: '55',
      fileSize: 4096,
    });

    expect(result).toEqual({ bridged: true, matchedFileIds: ['file-1'] });
    expect(files.find).toBeDefined();
    expect(ctx.filesRepo!.find).toHaveBeenCalledWith(expect.objectContaining({
      where: { telegramFileUniqueId: 'UNIQ-abc' },
    }));
    // 红线：写入的 file_id 必须是产生它的那个账号自己的，禁止跨账号借用
    expect(ctx.repo.create).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: 'file',
      ownerId: 'file-1',
      accountId: 'a2',
      telegramFileId: 'a2-own-file-id',
      chatId: '-100777',
      messageId: '55',
      fileSize: '4096',
      source: 'inbound',
    }));
  });

  it('来自中继目标群的认领标注 source=relayed（副本扩散生效的证据）', async () => {
    const ctx = setup({ files: ['file-1'] });

    await ctx.service.bridgeInboundCopyToLogicalFile({
      fileUniqueId: 'UNIQ-abc',
      accountId: 'a2',
      telegramFileId: 'a2-own-file-id',
      chatId: '-100222',
      messageId: '55',
      source: 'relayed',
    });

    expect(ctx.repo.create).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: 'file',
      source: 'relayed',
    }));
  });

  it('file_unique_id 不唯一时一对多桥接（同一内容被上传两次形成的多条记录）', async () => {
    const ctx = setup({ files: ['file-1', 'file-2'] });

    const result = await ctx.service.bridgeInboundCopyToLogicalFile({
      fileUniqueId: 'UNIQ-dup',
      accountId: 'a1',
      telegramFileId: 'a1-file',
      chatId: '-100777',
      messageId: '56',
    });

    expect(result.bridged).toBe(true);
    expect(result.matchedFileIds).toEqual(['file-1', 'file-2']);
    expect(ctx.repo.create).toHaveBeenCalledTimes(2);
  });

  it('未命中站内文件（群消息与站内无关）时不写库、不抛错', async () => {
    const ctx = setup({ files: [] });

    const result = await ctx.service.bridgeInboundCopyToLogicalFile({
      fileUniqueId: 'UNIQ-none',
      accountId: 'a1',
      telegramFileId: 'a1-file',
      chatId: '-100777',
      messageId: '57',
    });

    expect(result).toEqual({ bridged: false, matchedFileIds: [] });
    expect(ctx.repo.create).not.toHaveBeenCalled();
    expect(ctx.repo.save).not.toHaveBeenCalled();
  });

  it('逻辑文件仓库未装配（非池化部署/单测）时静默跳过', async () => {
    const ctx = setup({ files: null });

    const result = await ctx.service.bridgeInboundCopyToLogicalFile({
      fileUniqueId: 'UNIQ-abc',
      accountId: 'a1',
      telegramFileId: 'a1-file',
      chatId: '-100777',
      messageId: '58',
    });

    expect(result).toEqual({ bridged: false, matchedFileIds: [] });
    expect(ctx.repo.save).not.toHaveBeenCalled();
  });

  it('缺少 file_unique_id 时不做任何反查', async () => {
    const ctx = setup({ files: ['file-1'] });

    const result = await ctx.service.bridgeInboundCopyToLogicalFile({
      fileUniqueId: '   ',
      accountId: 'a1',
      telegramFileId: 'a1-file',
      chatId: '-100777',
      messageId: '59',
    });

    expect(result).toEqual({ bridged: false, matchedFileIds: [] });
    expect(ctx.filesRepo!.find).not.toHaveBeenCalled();
  });

  it('反查抛错时不影响入站主流程（返回未桥接）', async () => {
    const ctx = setup({ files: [] });
    ctx.filesRepo!.find.mockRejectedValue(new Error('index unavailable') as never);

    const result = await ctx.service.bridgeInboundCopyToLogicalFile({
      fileUniqueId: 'UNIQ-boom',
      accountId: 'a1',
      telegramFileId: 'a1-file',
      chatId: '-100777',
      messageId: '60',
    });

    expect(result).toEqual({ bridged: false, matchedFileIds: [] });
  });
});
