import { FileCopyService } from './file-copy.service';

function makeRepo() {
  return {
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    createQueryBuilder: jest.fn(),
    create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
    save: jest.fn(async (value: Record<string, unknown>) => ({ ...value, id: 'copy-1' })),
    update: jest.fn(async () => ({ affected: 1 })),
    delete: jest.fn(async (_where?: Record<string, unknown>) => ({ affected: 2 })),
  };
}

/** 账号池账号快照条目（只填复制目标判定关心的字段） */
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
  /** 构造一次已授予的准入（幂等归还；finish 会转调 finishAttempt 便于断言） */
  function grant(accountId: string, role = 'replication') {
    let settled = false;
    return {
      granted: true,
      admission: {
        accountId,
        role,
        largeFile: false,
        finish: jest.fn((sample?: unknown) => {
          if (settled) return;
          settled = true;
          (pool.finishAttempt as jest.Mock)(accountId, sample ?? { ok: true });
        }),
        release: jest.fn(() => { settled = true; }),
      },
    };
  }
  const pool = {
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
    /** 原子准入替身：默认全部授予（单测关注的是调用方的归还与计数语义） */
    admit: jest.fn((request: { accountId: string; role?: string }): Record<string, unknown> => grant(request.accountId, request.role)),
    bumpCounter: jest.fn(),
  };
  return pool;
}

function makeClient() {
  return {
    openRealtimeStream: jest.fn(),
    sendDocumentStream: jest.fn(),
  };
}

function makeFilesRepo(ids: string[] = []) {
  return {
    find: jest.fn(async () => ids.map((id) => ({ id }))),
  };
}

function setup(filesRepo: ReturnType<typeof makeFilesRepo> | null = null) {
  const repo = makeRepo();
  const pool = makePool();
  const client = makeClient();
  const service = new FileCopyService(
    repo as never,
    pool as never,
    client as never,
    null,
    filesRepo as never,
  );
  return { service, repo, pool, client };
}

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
      source: 'replicated',
    });

    expect(ctx.repo.create).not.toHaveBeenCalled();
    expect(ctx.repo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'copy-1',
      telegramFileId: 'fresh',
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

  it('同一 (owner, account) 的并发复制只执行一次（进程内去重）', async () => {
    const ctx = setup();
    // 无可用源 → doEnsureCopy 快速返回 null，便于观察调用次数
    ctx.repo.find.mockResolvedValue([]);

    const params = {
      ownerType: 'fileUnique' as const,
      ownerId: 'UNIQ-1',
      targetAccountId: 'a2',
      fileName: 'f.bin',
      expectedSize: 100,
    };
    const [first, second] = await Promise.all([
      ctx.service.ensureCopy(params),
      ctx.service.ensureCopy(params),
    ]);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(ctx.pool.getConfig).toHaveBeenCalledTimes(1);
    expect(ctx.repo.find).toHaveBeenCalledTimes(1);
    // 无可用源属于复制失败，必须计数（供告警判定）
    expect(ctx.pool.bumpCounter).toHaveBeenCalledWith('replicationsFailed');
  });

  it('目标额度不足时源流采样只回报一次（destroy 的 close 不重复释放在飞额度）', async () => {
    const ctx = setup();
    ctx.repo.find.mockResolvedValue([
      { id: 'c1', accountId: 'a1', telegramFileId: 'a1-file', fileSize: '100' },
    ] as never);

    // destroy 会同步触发 close；随后代码显式 settleSource，二者必须只回报一次
    const listeners: Record<string, Array<() => void>> = {};
    const fakeStream = {
      once: (event: string, handler: () => void) => {
        (listeners[event] ??= []).push(handler);
        return fakeStream;
      },
      destroy: () => {
        for (const handler of listeners.close ?? []) handler();
        return fakeStream;
      },
    };
    ctx.client.openRealtimeStream.mockResolvedValue({
      stream: fakeStream,
      info: { file_id: 'a1-file', file_size: 100 },
      sample: () => ({ ok: true, bytes: 1, durationMs: 1 }),
    } as never);
    // 第一次（源账号 a1）准入成功，第二次（目标账号 a2）复制额度不足
    const grantedSource = {
      granted: true as const,
      admission: {
        accountId: 'a1',
        role: 'replication' as const,
        largeFile: false,
        finish: jest.fn((sample?: unknown) => { (ctx.pool.finishAttempt as jest.Mock)('a1', sample ?? { ok: true }); }),
        release: jest.fn(),
      },
    };
    ctx.pool.admit
      .mockImplementationOnce(() => grantedSource)
      .mockImplementationOnce(() => ({ granted: false, reason: 'replication_full', admission: undefined }));
    const finishSpy = grantedSource.admission.finish as jest.Mock;

    const result = await ctx.service.ensureCopy({
      ownerType: 'fileUnique',
      ownerId: 'u1',
      targetAccountId: 'a2',
      fileName: 'f.bin',
      expectedSize: 100,
    });

    expect(result).toBeNull();
    // 源额度只能归还一次：destroy 触发的 close 与显式 settle 必须去重，
    // 否则在飞额度被双重扣减，账号看起来比实际空闲（限流保护被静默绕开）
    expect(finishSpy).toHaveBeenCalledTimes(1);
    const sourceFinishes = ctx.pool.finishAttempt.mock.calls.filter((call) => call[0] === 'a1');
    expect(sourceFinishes).toHaveLength(1);
  });

  it('源账号复制额度不足时不做复制（不排队占用下载资源）', async () => {
    const ctx = setup();
    ctx.repo.find.mockResolvedValue([
      { id: 'c1', accountId: 'a1', telegramFileId: 'a1-file', fileSize: '100' },
    ] as never);
    ctx.pool.admit.mockImplementation(() => ({ granted: false, reason: 'replication_full', admission: undefined }));

    const result = await ctx.service.ensureCopy({
      ownerType: 'fileUnique',
      ownerId: 'u1',
      targetAccountId: 'a2',
      fileName: 'f.bin',
      expectedSize: 100,
    });

    expect(result).toBeNull();
    // 复制是副产品：拿不到额度就本轮放弃，绝不发起上游取流
    expect(ctx.client.openRealtimeStream).not.toHaveBeenCalled();
    expect(ctx.client.sendDocumentStream).not.toHaveBeenCalled();
    expect(ctx.pool.bumpCounter).toHaveBeenCalledWith('replicationsFailed');
  });

  it('复制选源时排除已有复制流的账号（下载优先，不与下载争同一账号额度）', async () => {
    const ctx = setup();
    // 源副本只有 a1（不能被选为目标），目标 a2 → 选源候选恰好是 ['a1']
    ctx.repo.find.mockResolvedValue([
      { id: 'c1', accountId: 'a1', telegramFileId: 'a1-file', fileSize: '100' },
    ] as never);
    ctx.client.openRealtimeStream.mockResolvedValue({
      stream: { once: jest.fn(), destroy: jest.fn() },
      info: { file_id: 'a1-file', file_size: 100 },
      sample: () => ({ ok: true, bytes: 100, durationMs: 10 }),
    } as never);
    ctx.client.sendDocumentStream.mockResolvedValue({
      fileId: 'a2-file',
      fileSize: 100,
      chatId: '-1001',
      messageId: '9',
      fileUniqueId: 'UQ-a2',
      sample: { ok: true, bytes: 100, durationMs: 10 },
    } as never);

    await ctx.service.ensureCopy({
      ownerType: 'fileUnique',
      ownerId: 'u1',
      targetAccountId: 'a2',
      fileName: 'f.bin',
      expectedSize: 100,
    });

    // 复制选源必须声明复制角色（账号池据此排除已有复制流的账号）
    expect(ctx.pool.select).toHaveBeenCalledWith(
      ['a1'],
      expect.any(Number),
      expect.objectContaining({ role: 'replication' }),
    );
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
});

/**
 * 副本扩散的目标规划、跨请求去重与并发闸门。
 *
 * 事故背景（本组用例保护的语义）：`planTargets()` 只是「选号」，`pool.select()`
 * 不会占用任何在飞额度；若没有 single-flight 与目标 claim，并发下载会各自选出同一批
 * 目标并重复排队上传（表现为同一账号被反复重传、上游请求被放大）。
 */
describe('FileCopyService（副本扩散目标规划与去重）', () => {
  /** 让一次复制成功的最小桩（源流 + 目标上传回执） */
  function wireSuccessfulCopy(ctx: ReturnType<typeof setup>) {
    ctx.client.openRealtimeStream.mockResolvedValue({
      stream: { once: jest.fn(), destroy: jest.fn() },
      info: { file_id: 'a1-file', file_size: 100 },
      sample: () => ({ ok: true, bytes: 100, durationMs: 10 }),
    } as never);
    ctx.client.sendDocumentStream.mockResolvedValue({
      fileId: 'a2-file',
      fileSize: 100,
      chatId: '-1001',
      messageId: '9',
      fileUniqueId: 'UQ-a2',
      sample: { ok: true, bytes: 100, durationMs: 10 },
    } as never);
  }

  it('planTargets：已持有 ready 副本的账号不再作为目标，只补缺失账号', async () => {
    const ctx = setup();
    ctx.repo.find.mockResolvedValue([
      { id: 'c1', accountId: 'a1', telegramFileId: 'a1-file', fileSize: '100' },
    ] as never);

    const targets = await ctx.service.planTargets('fileUnique', 'UNIQ-1', 2);

    expect(targets).toEqual(['a2']);
  });

  it('planTargets：排除无存储 Chat / 冷却 / 满载 / 源账号，并给出可读原因', async () => {
    const ctx = setup();
    ctx.pool.storageAccountIds.mockReturnValue(['a2']);
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

    // 资格判定在「选中并 claim」之前
    const eligibility = ctx.service.evaluateTargetEligibility('fileUnique', 'UNIQ-1', [], 'a1');
    const byId = new Map(eligibility.map((item) => [item.accountId, item]));
    expect(byId.get('a1')?.reasons.join()).toContain('源账号');
    expect(byId.get('a3')?.reasons.join()).toContain('存储 Chat');
    expect(byId.get('a4')?.reasons.join()).toContain('冷却');
    expect(byId.get('a5')?.reasons.join()).toContain('在飞上限');
    expect(byId.get('a2')?.eligible).toBe(true);

    const targets = await ctx.service.planTargets('fileUnique', 'UNIQ-1', 5, 'a1');
    expect(targets).toEqual(['a2']);
    // 选中即占位：同一文件的目标在 claim 有效期内不会被再次选中
    const claimed = ctx.service.evaluateTargetEligibility('fileUnique', 'UNIQ-1', [], 'a1');
    expect(claimed.find((item) => item.accountId === 'a2')?.reasons.join()).toContain('排队中');
  });

  it('同一文件的并发 ensureCopies 只执行一轮扩散（single-flight）', async () => {
    const ctx = setup();
    ctx.repo.find.mockResolvedValue([
      { id: 'c1', accountId: 'a1', telegramFileId: 'a1-file', fileSize: '100' },
    ] as never);
    wireSuccessfulCopy(ctx);

    const params = {
      ownerType: 'fileUnique' as const,
      ownerId: 'UNIQ-1',
      fileName: 'f.bin',
      expectedSize: 100,
      desiredCount: 2,
    };
    const [first, second] = await Promise.all([
      ctx.service.ensureCopies(params),
      ctx.service.ensureCopies(params),
    ]);

    expect(first.created).toEqual(['a2']);
    expect(second.created).toEqual(['a2']);
    // 一次实际复制（源流 + 目标上传各一次），而不是两次
    expect(ctx.client.openRealtimeStream).toHaveBeenCalledTimes(1);
    expect(ctx.client.sendDocumentStream).toHaveBeenCalledTimes(1);
    // held 查询 + planTargets 的 held 查询 + performCopy 的选源查询 = 仅一轮（并发会翻倍）
    expect(ctx.repo.find).toHaveBeenCalledTimes(3);
  });

  it('复制失败后 claim 被释放：同一目标可在下一轮重试（不产生重复 pending）', async () => {
    const ctx = setup();
    ctx.repo.find.mockResolvedValue([
      { id: 'c1', accountId: 'a1', telegramFileId: 'a1-file', fileSize: '100' },
    ] as never);
    ctx.client.openRealtimeStream.mockResolvedValue({
      stream: { once: jest.fn(), destroy: jest.fn() },
      info: { file_id: 'a1-file', file_size: 100 },
      sample: () => ({ ok: true, bytes: 100, durationMs: 10 }),
    } as never);
    ctx.client.sendDocumentStream
      .mockRejectedValueOnce(new Error('flood wait'))
      .mockResolvedValueOnce({
        fileId: 'a2-file',
        fileSize: 100,
        chatId: '-1001',
        messageId: '9',
        fileUniqueId: 'UQ-a2',
        sample: { ok: true, bytes: 100, durationMs: 10 },
      } as never);

    const params = {
      ownerType: 'fileUnique' as const,
      ownerId: 'UNIQ-1',
      fileName: 'f.bin',
      expectedSize: 100,
      desiredCount: 2,
    };
    const failed = await ctx.service.ensureCopies(params);
    expect(failed.created).toEqual([]);
    expect(failed.failed.map((item) => item.accountId)).toEqual(['a2']);

    const retried = await ctx.service.ensureCopies(params);
    expect(retried.created).toEqual(['a2']);
    expect(ctx.client.sendDocumentStream).toHaveBeenCalledTimes(2);
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
 * 入站副本 → 站内文件桥接。
 *
 * 事故背景（本组用例保护的语义）：入站登记写 `ownerType='fileUnique'`，而站内下载只查
 * `ownerType='file'`；两侧不打通时，副本可见群里各 Bot 认领到的副本永远不会被下载选号消费，
 * 「让所有 Bot 都能获取副本实现负载均衡」形同虚设。
 */
describe('FileCopyService（入站副本桥接到站内逻辑文件）', () => {
  it('命中单个逻辑文件时写入 ownerType=file 副本，且只用该账号自己的 file_id', async () => {
    const files = makeFilesRepo(['file-1']);
    const ctx = setup(files);

    const result = await ctx.service.bridgeInboundCopyToLogicalFile({
      fileUniqueId: 'UNIQ-abc',
      accountId: 'a2',
      telegramFileId: 'a2-own-file-id',
      chatId: '-100777',
      messageId: '55',
      fileSize: 4096,
    });

    expect(result).toEqual({ bridged: true, matchedFileIds: ['file-1'] });
    expect(files.find).toHaveBeenCalledWith(expect.objectContaining({
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

  it('file_unique_id 不唯一时一对多桥接（同一内容被上传两次形成的多条记录）', async () => {
    const ctx = setup(makeFilesRepo(['file-1', 'file-2']));

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
    const ctx = setup(makeFilesRepo([]));

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
    const ctx = setup(null);

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
    const files = makeFilesRepo(['file-1']);
    const ctx = setup(files);

    const result = await ctx.service.bridgeInboundCopyToLogicalFile({
      fileUniqueId: '   ',
      accountId: 'a1',
      telegramFileId: 'a1-file',
      chatId: '-100777',
      messageId: '59',
    });

    expect(result).toEqual({ bridged: false, matchedFileIds: [] });
    expect(files.find).not.toHaveBeenCalled();
  });

  it('反查抛错时不影响入站主流程（返回未桥接）', async () => {
    const files = makeFilesRepo([]);
    files.find.mockRejectedValue(new Error('index unavailable') as never);
    const ctx = setup(files);

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
