import { FileCopyService } from './file-copy.service';

function makeRepo() {
  return {
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
    save: jest.fn(async (value: Record<string, unknown>) => ({ ...value, id: 'copy-1' })),
    update: jest.fn(async () => ({ affected: 1 })),
    delete: jest.fn(async (_where?: Record<string, unknown>) => ({ affected: 2 })),
  };
}

function makePool() {
  return {
    ids: jest.fn(() => ['a1', 'a2']),
    getConfig: jest.fn((id: string) => (id === 'a1' || id === 'a2'
      ? { id, token: `${id}:SECRET`, chatId: '-1001', weight: 1, maxInflight: 8, enabled: true }
      : null)),
    select: jest.fn((candidates?: string[]) => (candidates?.length ? { accountId: candidates[0], score: 1, reason: 'test' } : null)),
    beginAttempt: jest.fn(() => true),
    releaseAttempt: jest.fn(),
    finishAttempt: jest.fn(),
    bumpCounter: jest.fn(),
  };
}

function makeClient() {
  return {
    openRealtimeStream: jest.fn(),
    sendDocumentStream: jest.fn(),
  };
}

function setup() {
  const repo = makeRepo();
  const pool = makePool();
  const client = makeClient();
  const service = new FileCopyService(repo as never, pool as never, client as never, null);
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

  it('findByAnchor 按 (chatId, messageId) 反查逻辑主键', async () => {
    const ctx = setup();
    await ctx.service.findByAnchor('7001', '100');

    expect(ctx.repo.findOne).toHaveBeenCalledWith({ where: { chatId: '7001', messageId: '100' } });
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
    // 第一次（源账号）成功占用，第二次（目标账号）额度不足
    ctx.pool.beginAttempt.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const result = await ctx.service.ensureCopy({
      ownerType: 'fileUnique',
      ownerId: 'u1',
      targetAccountId: 'a2',
      fileName: 'f.bin',
      expectedSize: 100,
    });

    expect(result).toBeNull();
    const sourceFinishes = ctx.pool.finishAttempt.mock.calls.filter((call) => call[0] === 'a1');
    expect(sourceFinishes).toHaveLength(1);
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
