import { Logger } from '@nestjs/common';
import { FileCopyService } from './file-copy.service';
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
  /** 传入数组即装配逻辑文件仓库（桥接用）；传 null 表示未装配 */
  files?: string[] | null;
}

/**
 * 装配被测服务。
 *
 * 本服务现在**只做副本事实的读写与统计**：扩散执行已收敛到镜像任务队列
 * （主群 → userbot → 各镜像群），因此这里不再需要中继/轮次替身。
 */
function setup(options: SetupOptions = {}) {
  const repo = makeRepo();
  const pool = makePool();
  const filesRepo = options.files === undefined ? null : makeFilesRepo(options.files ?? []);
  const ready = (options.ready ?? []).map((accountId) => copyRow(accountId));

  repo.find.mockImplementation(async (findOptions?: unknown) => {
    const where = (findOptions as { where?: Record<string, unknown> } | undefined)?.where ?? {};
    if ('chatId' in where) return [];
    return ready;
  });

  const service = new FileCopyService(
    repo as never,
    pool as never,
    filesRepo as never,
  );
  return { service, repo, pool, ready, filesRepo };
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
 * 入站副本桥接：把「群内 Bot 认领到自己账号的 file_id」接到站内逻辑文件上。
 *
 * 事故背景（本组用例保护的语义）：副本扩散的完成条件是**群内各 Bot 各自认领**
 * （用户账号把消息转发进群后，群内每个 Bot 都会收到该消息）。入站桥接若把
 * 「别的账号的 file_id」写成本账号的副本，下载时会用错误的账号去取文件——
 * 因此这里必须**只用该账号自己的 file_id**。
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

/**
 * 覆盖上传后的旧副本失效：副本行没有内容版本，覆盖会换掉 telegramFileId，
 * 其它账号的旧行仍会被 `listReady` 选中并回源（表现为「覆盖后下载到旧内容」），
 * 必须按归属整体删除——本组用例保护这条唯一的内容一致性手段。
 */
describe('FileCopyService（按归属失效旧内容副本）', () => {
  it('invalidateByOwner 删除其它账号行、保留 exceptAccountId 指定行，并返回受影响行数', async () => {
    const ctx = setup();
    ctx.repo.delete.mockResolvedValueOnce({ affected: 3 } as never);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const removed = await ctx.service.invalidateByOwner('file', 'file-1', 'a2');

      expect(removed).toBe(3);
      const where = ctx.repo.delete.mock.calls[0][0] as Record<string, unknown>;
      expect(where.ownerType).toBe('file');
      expect(where.ownerId).toBe('file-1');
      // 保留 exceptAccountId：删除条件必须带 `accountId != except`（Not 运算符），
      // 否则会连本次上传账号随后要写的主副本行一起删掉
      const accountCondition = where.accountId as { type?: string; value?: unknown } | undefined;
      expect(accountCondition?.type).toBe('not');
      expect(accountCondition?.value).toBe('a2');
      // 命中时留一条脱敏日志（ownerId 经 preview 截断，不打印 file_id）
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('已失效旧内容副本'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('invalidateByOwner 不带 exceptAccountId 时删除该归属的全部行（条件不含账号过滤）', async () => {
    const ctx = setup();
    ctx.repo.delete.mockResolvedValueOnce({ affected: 2 } as never);

    const removed = await ctx.service.invalidateByOwner('file', 'file-1');

    expect(removed).toBe(2);
    expect(ctx.repo.delete).toHaveBeenCalledWith({ ownerType: 'file', ownerId: 'file-1' });
  });

  it('invalidateByOwner 无匹配行时返回 0 且不抛错（不误报）', async () => {
    const ctx = setup();
    ctx.repo.delete.mockResolvedValueOnce({ affected: 0 } as never);

    await expect(ctx.service.invalidateByOwner('file', 'file-1', 'a1')).resolves.toBe(0);
  });

  it('invalidateByOwner 仓库抛错时返回 0 并只记 warn（绝不阻断上传主流程）', async () => {
    const ctx = setup();
    ctx.repo.delete.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked') as never);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    try {
      const removed = await ctx.service.invalidateByOwner('file', 'file-1', 'a2');

      expect(removed).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('副本失效删除失败'));
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

/**
 * 批量取 ready 副本：历史补偿等批处理场景用它替代逐文件 `listReady`（避免 N+1）。
 * 本组用例守住三个边界：空数组不查库、按 ownerId 分组、take 有界。
 */
describe('FileCopyService（批量取 ready 副本 listReadyByOwnerIds）', () => {
  it('空数组（含空白项）直接返回空 Map，且不查库', async () => {
    const ctx = setup();

    const empty = await ctx.service.listReadyByOwnerIds('file', []);
    const blanks = await ctx.service.listReadyByOwnerIds('file', ['', '   ']);

    expect(empty.size).toBe(0);
    expect(blanks.size).toBe(0);
    expect(ctx.repo.find).not.toHaveBeenCalled();
  });

  it('按 ownerId 分组返回，且 take 有界（去重后归属数 × 8）', async () => {
    const ctx = setup();
    ctx.repo.find.mockResolvedValue([
      copyRow('a1', { ownerId: 'file-1' }),
      copyRow('a2', { ownerId: 'file-1' }),
      copyRow('a1', { ownerId: 'file-2' }),
    ] as never);

    const result = await ctx.service.listReadyByOwnerIds('file', ['file-1', 'file-2', 'file-1', ' ']);

    // 一次查询（不是逐文件查询），重复/空白项被去重后作为 IN 条件
    expect(ctx.repo.find).toHaveBeenCalledTimes(1);
    const findArgs = ctx.repo.find.mock.calls[0][0]! as {
      where: { ownerType?: string; status?: string; ownerId?: { type?: string; value?: unknown } };
      take?: number;
    };
    expect(findArgs.where.ownerType).toBe('file');
    expect(findArgs.where.status).toBe('ready');
    expect(findArgs.where.ownerId?.type).toBe('in');
    expect(findArgs.where.ownerId?.value).toEqual(['file-1', 'file-2']);
    // 有界：2 个去重归属 × 8 = 16（单归属最多取 8 行足够判定可执行性）
    expect(findArgs.take).toBe(16);
    expect(result.get('file-1')).toHaveLength(2);
    expect(result.get('file-2')).toHaveLength(1);
  });

  it('无匹配行时返回空 Map（不误报、不抛错）', async () => {
    const ctx = setup();
    ctx.repo.find.mockResolvedValue([] as never);

    const result = await ctx.service.listReadyByOwnerIds('file', ['file-1']);

    expect(result.size).toBe(0);
  });
});
