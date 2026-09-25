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
  coolingDownAccounts?: string[];
  busyOnceAccounts?: string[];
  openStreamReturnsNull?: boolean;
  ensureCopies?: jest.Mock;
} = {}) {
  const counters: Counters = {
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
  };
  const available = new Set(['a1', 'a2', 'a3', ...(options.readyAccounts ?? [])]);
  const failAccounts = new Set(options.failAccounts ?? []);
  const busyOnceAccounts = new Set(options.busyOnceAccounts ?? []);
  const busySnapshotAccounts = new Set(options.busyOnceAccounts ?? []);

  /** 在飞计数（让准入与释放能被断言） */
  const inflight = new Map<string, number>();
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
    /**
     * 原子准入的最小可用替身：复现真实语义中本层测试关心的两条——
     * 冷却中拒绝（`coolingDownAccounts`）、未禁用才授予，其余一律放行。
     */
    admit: jest.fn((request: { accountId: string; role?: string; bytes?: number }) => {
      if (!available.has(request.accountId)) return { granted: false, reason: 'unknown_account' as const };
      if ((options.coolingDownAccounts ?? []).includes(request.accountId)) {
        return { granted: false, reason: 'cooling_down' as const, retryAfterMs: 1_000 };
      }
      if (busyOnceAccounts.has(request.accountId)) {
        busyOnceAccounts.delete(request.accountId);
        busySnapshotAccounts.delete(request.accountId);
        return { granted: false, reason: 'large_inflight_full' as const, retryAfterMs: 500 };
      }
      const current = inflight.get(request.accountId) ?? 0;
      inflight.set(request.accountId, current + 1);
      let settled = false;
      return {
        granted: true,
        admission: {
          accountId: request.accountId,
          role: request.role ?? 'download',
          largeFile: false,
          finish: (sample?: unknown) => {
            if (settled) return;
            settled = true;
            inflight.set(request.accountId, Math.max(0, (inflight.get(request.accountId) ?? 1) - 1));
            (pool.finishAttempt as jest.Mock)(request.accountId, sample ?? { ok: true });
          },
          release: () => {
            if (settled) return;
            settled = true;
            inflight.set(request.accountId, Math.max(0, (inflight.get(request.accountId) ?? 1) - 1));
          },
        },
      };
    }),
    snapshot: jest.fn(() => ({
      enabled: true,
      inactiveReason: null,
      counters: { ...counters },
      accounts: Array.from(available).map((id) => ({
        id,
        enabled: true,
        coolingDown: (options.coolingDownAccounts ?? []).includes(id),
        cooldownRemainingMs: 1_000,
        inflight: inflight.get(id) ?? 0,
        maxInflight: 8,
        largeInflight: busySnapshotAccounts.has(id) ? 1 : 0,
        maxLargeInflight: 1,
      })),
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
    ensureCopies: options.ensureCopies ?? jest.fn(async () => ({
      status: 'succeeded',
      created: [],
      missing: [],
      relayed: false,
    })),
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

  it('三个账号回源失败后继续尝试第四个 ready 副本', async () => {
    const ctx = setup({ readyAccounts: ['a1', 'a2', 'a3', 'a4'], failAccounts: ['a1', 'a2', 'a3'] });
    const result = await ctx.service.openStream({ ownerType: 'fileUnique', ownerId: 'u1' });

    expect(result?.accountId).toBe('a4');
    expect(ctx.client.openRealtimeStream).toHaveBeenCalledTimes(4);
    expect(ctx.counters.selections).toBe(4);
    expect(ctx.counters.failovers).toBe(3);
    expect(ctx.counters.streamFailures).toBe(3);
  });

  it('全部 ready 候选失败时返回可诊断摘要', async () => {
    const ctx = setup({ readyAccounts: ['a1', 'a2', 'a3'], failAccounts: ['a1', 'a2', 'a3'] });
    const onUnavailable = jest.fn();
    const result = await ctx.service.openStream({ ownerType: 'fileUnique', ownerId: 'u1', onUnavailable });

    expect(result).toBeNull();
    expect(ctx.client.openRealtimeStream).toHaveBeenCalledTimes(3);
    expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'upstream_attempts_failed',
      readyAccountCount: 3,
      attemptedAccountCount: 3,
    }));
  });

  it('唯一 ready 副本短暂大文件满载时等待槽位释放后回源，不立即 503', async () => {
    const ctx = setup({ readyAccounts: ['a1'], busyOnceAccounts: ['a1'] });
    const onUnavailable = jest.fn();
    const result = await ctx.service.openStream({
      ownerType: 'fileUnique',
      ownerId: 'u1',
      expectedSize: 2 * 1024 ** 3,
      onUnavailable,
    });

    expect(result?.accountId).toBe('a1');
    expect(ctx.client.openRealtimeStream).toHaveBeenCalledTimes(1);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('下载路径不产生任何扩散副作用（扩散改为提交即触发）', async () => {
    // 历史实现：副本不足时在下载路径后台触发扩散。现在扩散只由「提交即触发」的镜像任务负责，
    // 下载侧必须零副作用——否则「谁下载谁触发」会让扩散时机不可预测、也无法按镜像群统计。
    const ensureCopies = jest.fn((_params: Record<string, unknown>) => new Promise(() => undefined));
    const ctx = setup({ readyAccounts: ['a1'], ensureCopies: ensureCopies as unknown as jest.Mock });

    const result = await ctx.service.openStream({
      ownerType: 'fileUnique',
      ownerId: 'u1',
      expectedSize: 100,
      fileName: 'report.pdf',
    });

    expect(result?.accountId).toBe('a1');
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

  it('源账号处于限流冷却时拒绝兜底（不硬打，避免延长冷却）', async () => {
    // 这是「单账号独扛」的正反馈来源：历史实现对该路径完全不检查冷却，
    // 源账号被 DC-5 限流后仍被反复回源，冷却窗口不断延长。
    const ctx = setup({ coolingDownAccounts: ['a2'] });
    const result = await ctx.service.openSourceStream({ accountId: 'a2', fileId: 'f' });

    expect(result).toBeNull();
    expect(ctx.client.openRealtimeStream).not.toHaveBeenCalled();
    expect(ctx.counters.fallbackThrottled).toBe(1);
  });

  it('每个候选账号自己持有副本：只用该账号的 file_id 回源（不跨账号串用）', async () => {
    const ctx = setup({ readyAccounts: ['a1', 'a2'] });
    await ctx.service.openStream({
      ownerType: 'fileUnique',
      ownerId: 'u1',
      expectedSize: 100,
      fileName: 'report.pdf',
    });

    // 选号选中 a1（确定性桩），取流用的必须是 a1 自己的副本 file_id
    const call = (ctx.client.openRealtimeStream as jest.Mock).mock.calls[0];
    expect(call[0]).toBe('a1');
    expect(call[2]).toBe('a1-file');
  });

  it('候选账号准入被拒时换下一个候选（不把请求压在一个账号上）', async () => {
    const ctx = setup({ readyAccounts: ['a1', 'a2'], coolingDownAccounts: ['a1'] });
    await ctx.service.openStream({
      ownerType: 'fileUnique',
      ownerId: 'u1',
      expectedSize: 100,
      fileName: 'report.pdf',
    });

    // a1 冷却中 → 换到 a2，并计入 failovers
    const call = (ctx.client.openRealtimeStream as jest.Mock).mock.calls[0];
    expect(call[0]).toBe('a2');
    expect(call[2]).toBe('a2-file');
    expect(ctx.counters.failovers).toBe(1);
  });
});
