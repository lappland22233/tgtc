import { Readable } from 'stream';
import { AccountAwareDownloadService } from './account-aware-download.service';
import { TelegramAccountError } from './telegram-account-client.service';

type Counters = Record<string, number>;

function streamSession(fileId = 'f') {
  return {
    stream: Readable.from([Buffer.from('x')]),
    info: { file_id: fileId, file_size: 100 },
    sample: () => ({ ok: true, bytes: 1, durationMs: 1 }),
  };
}

function accountConfig(id: string) {
  return { id, token: `${id}-token:SECRET`, chatId: `-100${id}`, weight: 1, maxInflight: 8, enabled: true };
}

function setup(options: {
  active?: boolean;
  readyAccounts?: string[];
  failAccounts?: string[];
  openStreamReturnsNull?: boolean;
  ensureCopies?: jest.Mock;
} = {}) {
  const counters: Counters = {
    selections: 0,
    failovers: 0,
    fallbacks: 0,
    unresolved: 0,
    replicationsOk: 0,
    replicationsFailed: 0,
    streamFailures: 0,
    replyFailures: 0,
    inboundRegistrationFailures: 0,
  };
  const available = new Set(['a1', 'a2', 'a3']);
  const failAccounts = new Set(options.failAccounts ?? []);

  const pool = {
    isActive: jest.fn(() => options.active ?? true),
    inactiveReason: jest.fn(() => null),
    getConfig: jest.fn((id: string) => (available.has(id) ? accountConfig(id) : null)),
    // 确定性选号：总取候选中的第一个（换号测试正是验证 excluded 是否生效）
    select: jest.fn((ids?: string[]) => (options.openStreamReturnsNull || !ids?.length
      ? null
      : { accountId: ids[0], score: 1, reason: 'test' })),
    beginAttempt: jest.fn(() => true),
    releaseAttempt: jest.fn(),
    finishAttempt: jest.fn(),
    snapshot: jest.fn(() => ({
      enabled: true,
      inactiveReason: null,
      counters: { ...counters },
      accounts: [],
    })),
    bumpCounter: jest.fn((key: string, delta = 1) => { counters[key] += delta; }),
  };

  const client = {
    openRealtimeStream: jest.fn(async (accountId: string) => {
      if (failAccounts.has(accountId)) {
        throw new TelegramAccountError('429 Too Many Requests', accountId, 'flood', 429, 30);
      }
      return streamSession(`${accountId}-file`);
    }),
  };

  const copies = {
    listReady: jest.fn(async () => (options.readyAccounts ?? []).map((accountId) => ({
      id: `copy-${accountId}`,
      accountId,
      telegramFileId: `${accountId}-file`,
    }))),
    ensureCopies: options.ensureCopies ?? jest.fn(async () => ({ created: [], skipped: [], failed: [], relayed: false })),
    touchUsed: jest.fn(async () => undefined),
  };

  const service = new AccountAwareDownloadService(
    pool as never,
    client as never,
    copies as never,
  );

  return { service, pool, client, copies, counters };
}

describe('AccountAwareDownloadService（选号 / 换号 / 非阻断懒扩散）', () => {
  it('未启用账号池时直接返回 null（交由调用方走原单账号链路）', async () => {
    const ctx = setup({ active: false, readyAccounts: ['a1'] });
    const result = await ctx.service.openStream({ ownerType: 'fileUnique', ownerId: 'u1' });

    expect(result).toBeNull();
    expect(ctx.copies.listReady).not.toHaveBeenCalled();
  });

  it('没有 ready 副本时返回 null（不猜账号、不误回源）', async () => {
    const ctx = setup({ readyAccounts: [] });
    const result = await ctx.service.openStream({ ownerType: 'fileUnique', ownerId: 'u1' });

    expect(result).toBeNull();
    expect(ctx.client.openRealtimeStream).not.toHaveBeenCalled();
  });

  it('首选账号失败后换号成功，并分别计数（选号/换号/流式失败）', async () => {
    const ctx = setup({ readyAccounts: ['a1', 'a2'], failAccounts: ['a1'] });
    const result = await ctx.service.openStream({ ownerType: 'fileUnique', ownerId: 'u1' });

    expect(result?.accountId).toBe('a2');
    expect(ctx.client.openRealtimeStream).toHaveBeenCalledTimes(2);
    expect(ctx.counters.selections).toBe(2);
    expect(ctx.counters.failovers).toBe(1);
    expect(ctx.counters.streamFailures).toBe(1);
    // 失败账号必须按错误分类进入冷却
    expect(ctx.pool.finishAttempt).toHaveBeenCalledWith('a1', expect.objectContaining({
      ok: false,
      failureKind: 'flood',
      status: 429,
      retryAfterSeconds: 30,
    }));
  });

  it('全部候选失败时返回 null（换号次数受限，不无限放大上游请求）', async () => {
    const ctx = setup({ readyAccounts: ['a1', 'a2', 'a3'], failAccounts: ['a1', 'a2', 'a3'] });
    const result = await ctx.service.openStream({ ownerType: 'fileUnique', ownerId: 'u1' });

    expect(result).toBeNull();
    // 最多尝试 3 个账号：成功选号 3 次、换号 2 次、流式失败 3 次
    expect(ctx.client.openRealtimeStream).toHaveBeenCalledTimes(3);
    expect(ctx.counters.selections).toBe(3);
    expect(ctx.counters.failovers).toBe(2);
    expect(ctx.counters.streamFailures).toBe(3);
  });

  it('全部候选都不可调度（冷却/满载）时不等待过久，直接返回 null 交给回退矩阵', async () => {
    const ctx = setup({ readyAccounts: ['a1'], openStreamReturnsNull: true });
    const result = await ctx.service.openStream({ ownerType: 'fileUnique', ownerId: 'u1' });

    expect(result).toBeNull();
    expect(ctx.client.openRealtimeStream).not.toHaveBeenCalled();
  });

  it('副本不足时后台触发懒扩散，且不阻塞首个字节', async () => {
    const never = jest.fn(() => new Promise(() => undefined));
    const ctx = setup({ readyAccounts: ['a1'], ensureCopies: never as unknown as jest.Mock });

    const result = await ctx.service.openStream({
      ownerType: 'fileUnique',
      ownerId: 'u1',
      expectedSize: 100,
      fileName: 'report.pdf',
      desiredReplicas: 2,
    });

    expect(result?.accountId).toBe('a1');
    expect(never).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: 'fileUnique',
      ownerId: 'u1',
      fileName: 'report.pdf',
      expectedSize: 100,
      desiredCount: 2,
    }));
  });

  it('扩散持续失败时进入退避窗口，不再随每次下载反复放大上传请求', async () => {
    const ensureCopies = jest.fn(async () => ({
      created: [],
      skipped: [],
      failed: [{ accountId: 'a2', error: 'storage chat invalid' }],
      relayed: false,
    }));
    const ctx = setup({ readyAccounts: ['a1'], ensureCopies: ensureCopies as unknown as jest.Mock });

    const params = {
      ownerType: 'fileUnique' as const,
      ownerId: 'u1',
      expectedSize: 100,
      fileName: 'report.pdf',
      desiredReplicas: 2,
    };

    await ctx.service.openStream(params);
    // 等后台扩散的 then 链完成（写入退避窗口）
    await new Promise((resolve) => setImmediate(resolve));
    // 第二次下载命中退避窗口 → 不再触发扩散
    await ctx.service.openStream(params);

    expect(ensureCopies).toHaveBeenCalledTimes(1);
  });

  it('副本已足够时不触发扩散', async () => {
    const ensureCopies = jest.fn();
    const ctx = setup({ readyAccounts: ['a1', 'a2'], ensureCopies: ensureCopies as unknown as jest.Mock });

    await ctx.service.openStream({
      ownerType: 'fileUnique',
      ownerId: 'u1',
      expectedSize: 100,
      fileName: 'report.pdf',
      desiredReplicas: 2,
    });

    expect(ensureCopies).not.toHaveBeenCalled();
  });

  it('源账号定向回源：只用该账号自己的 file_id，并标注选择依据', async () => {
    const ctx = setup();
    const result = await ctx.service.openSourceStream({
      accountId: 'a2',
      fileId: 'a2-own-file-id',
      expectedSize: 100,
      noCache: true,
    });

    expect(result?.selectionReason).toBe('source-account-fallback');
    expect(result?.copy).toBeNull();
    expect(ctx.client.openRealtimeStream).toHaveBeenCalledWith(
      'a2',
      'a2-token:SECRET',
      'a2-own-file-id',
      100,
      { noCache: true },
    );
  });

  it('源账号不在池内时返回 null（调用方据此 fail-closed，不回退默认账号）', async () => {
    const ctx = setup();
    const result = await ctx.service.openSourceStream({ accountId: 'unknown', fileId: 'f' });

    expect(result).toBeNull();
    expect(ctx.client.openRealtimeStream).not.toHaveBeenCalled();
  });

  it('源账号回源失败时返回 null 并计数（不抛异常影响回退判定）', async () => {
    const ctx = setup({ failAccounts: ['a2'] });
    const result = await ctx.service.openSourceStream({ accountId: 'a2', fileId: 'f' });

    expect(result).toBeNull();
    expect(ctx.counters.streamFailures).toBe(1);
    expect(ctx.pool.finishAttempt).toHaveBeenCalledWith('a2', expect.objectContaining({ ok: false }));
  });
});
