import { Readable } from 'stream';
import { UserPreferredDownloadService } from './user-preferred-download.service';
import { DOWNLOAD_ERROR_CODES, DownloadResourceException } from './download-resource-coordinator.service';
import { TelegramUserClientError } from '../telegram-user/telegram-user-client.service';

/**
 * 下载优先 user 账号的**开关语义**与 fail-open 契约。
 *
 * 最重要的一条：开关关闭时该服务必须完全不介入（返回 null 且不触碰任何依赖），
 * 这是 30 天后一键回退的基础，也是「改造前行为逐字节不变」的保证。
 */
function setup(options: {
  enabled?: boolean;
  accounts?: Array<Record<string, unknown>>;
  anchor?: { chatId: string; messageId: string } | null;
  openImpl?: () => Promise<{ stream: Readable; size: number | null }>;
  slotRejects?: boolean;
  /** 让占租约抛出指定异常（用于验证容量异常不冷却账号） */
  slotError?: unknown;
  /** 单账号并发上限（默认 4，与 DOWNLOAD_CONFIG_DEFAULTS 一致） */
  maxStreams?: number;
  /** 瞬时失败冷却（毫秒，默认 10000） */
  failureCooldownMs?: number;
} = {}) {
  const accounts = options.accounts ?? [{
    id: 'user-1',
    externalId: '9282584998',
    apiId: 12345,
    apiHash: 'hash',
    session: 'sess',
    primaryChatId: null,
    weight: 1,
    capabilities: null,
  }];
  const userClient = {
    isAvailable: jest.fn(() => true),
    openUserStream: jest.fn(options.openImpl ?? (async () => ({
      stream: Readable.from([Buffer.from('data')]),
      size: 4,
    }))),
  };
  const directory = { listEnabled: jest.fn(async () => accounts) };
  const anchors = { findReadyAnchorForDownload: jest.fn(async () => options.anchor ?? null) };
  const cacheConfig = { isPreferUserAccount: jest.fn(() => options.enabled ?? true) };
  const release = jest.fn();
  const resources = {
    getConfig: jest.fn(() => ({
      directWaitMs: 60_000,
      userStreamMaxConcurrency: options.maxStreams ?? 4,
      userFailureCooldownMs: options.failureCooldownMs ?? 10_000,
    })),
    acquireUpstreamSlot: jest.fn(async () => {
      if (options.slotError !== undefined) throw options.slotError;
      if (options.slotRejects) throw new Error('upstream busy');
      return { release };
    }),
  };
  const service = new UserPreferredDownloadService(
    userClient as never,
    directory as never,
    anchors as never,
    cacheConfig as never,
    resources as never,
  );
  return { service, userClient, directory, anchors, cacheConfig, resources, release };
}
describe('UserPreferredDownloadService', () => {
  it('开关关闭：不触碰任何依赖，直接返回 null（回退 Bot）', async () => {
    const ctx = setup({ enabled: false });

    const result = await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1', expectedSize: 100 });

    expect(result).toBeNull();
    expect(ctx.directory.listEnabled).not.toHaveBeenCalled();
    expect(ctx.anchors.findReadyAnchorForDownload).not.toHaveBeenCalled();
    expect(ctx.userClient.openUserStream).not.toHaveBeenCalled();
  });

  it('无可用 user 账号：返回 null', async () => {
    const ctx = setup({ accounts: [] });

    const result = await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' });

    expect(result).toBeNull();
    expect(ctx.userClient.openUserStream).not.toHaveBeenCalled();
  });

  it('无 user 可读锚点：返回 null，且不记失败也不开流', async () => {
    const ctx = setup({ anchor: null });

    const result = await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' });

    expect(result).toBeNull();
    expect(ctx.anchors.findReadyAnchorForDownload).toHaveBeenCalledWith('file', 'f1', undefined);
    expect(ctx.userClient.openUserStream).not.toHaveBeenCalled();
  });

  it('命中：用锚点开流，并按真实体量申请上行权重', async () => {
    const ctx = setup({ anchor: { chatId: '-100main', messageId: '777' } });

    const result = await ctx.service.tryOpen({ ownerType: 'grant', ownerId: 'g1', expectedSize: 2048 });

    expect(result).not.toBeNull();
    expect(ctx.resources.acquireUpstreamSlot).toHaveBeenCalledWith(
      expect.objectContaining({ bytes: 2048 }),
    );
    expect(ctx.userClient.openUserStream).toHaveBeenCalledWith(
      expect.objectContaining({ apiId: 12345, apiHash: 'hash', session: 'sess' }),
      expect.objectContaining({ chatId: '-100main', messageId: '777', expectedSize: 2048 }),
    );
  });

  it('取流失败：返回 null 并释放上行租约（不抛错、不阻断下载）', async () => {
    const ctx = setup({
      anchor: { chatId: '-100main', messageId: '777' },
      openImpl: async () => { throw new TelegramUserClientError('FLOOD_WAIT_30', 'flood', 30); },
    });

    await expect(ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' })).resolves.toBeNull();
    expect(ctx.release).toHaveBeenCalledTimes(1);
  });

  it('上行预算不足：直接回退，不开流，账号槽位归还', async () => {
    const ctx = setup({
      anchor: { chatId: '-100main', messageId: '777' },
      slotRejects: true,
      maxStreams: 1,
    });

    await expect(ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' })).resolves.toBeNull();
    expect(ctx.userClient.openUserStream).not.toHaveBeenCalled();

    // 账号槽位必须归还：上限 1 时，租约恢复后下一次调用仍应占到名额
    ctx.resources.acquireUpstreamSlot.mockImplementation(async () => ({ release: ctx.release }));
    expect(await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' })).not.toBeNull();
  });

  it('容量等待超时（SERVER_BUSY）不冷却账号：租约恢复后同账号仍可开流', async () => {
    // 事故回归：等 slot 15s 超时曾被当成账号失败，把唯一 user 账号冷却 60s，
    // 随后所有下载全部回退 Bot。容量拒绝必须只回退本次请求。
    const ctx = setup({
      anchor: { chatId: '-100main', messageId: '777' },
      slotError: new DownloadResourceException({
        status: 503,
        errorCode: DOWNLOAD_ERROR_CODES.SERVER_BUSY,
        message: '下载连接等待超时，请稍后重试',
        scope: 'upstream',
      }),
    });

    await expect(ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' })).resolves.toBeNull();
    expect(ctx.userClient.openUserStream).not.toHaveBeenCalled();

    // 租约恢复（容量问题消失）：同一账号必须仍被视为可用
    ctx.resources.acquireUpstreamSlot.mockImplementation(async () => ({ release: ctx.release }));
    const retried = await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' });

    expect(retried).not.toBeNull();
    expect(ctx.userClient.openUserStream).toHaveBeenCalledTimes(1);
  });

  it('并发上限读取配置：maxStreams=1 时第二个并发下载直接回退 Bot', async () => {
    const { PassThrough } = require('stream') as typeof import('stream');
    const ctx = setup({
      anchor: { chatId: '-100main', messageId: '777' },
      maxStreams: 1,
      openImpl: async () => ({ stream: new PassThrough(), size: 4 }),
    });

    expect(await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' })).not.toBeNull();
    expect(await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f2' })).toBeNull();
    expect(ctx.userClient.openUserStream).toHaveBeenCalledTimes(1);
  });

  it('瞬时失败冷却时长可配：日志按配置的秒数冷却', async () => {
    const ctx = setup({
      anchor: { chatId: '-100main', messageId: '777' },
      failureCooldownMs: 5_000,
      openImpl: async () => { throw new TelegramUserClientError('stream reset', 'other'); },
    });
    const warn = jest.spyOn(
      (ctx.service as unknown as { logger: { warn(...args: unknown[]): void } }).logger,
      'warn',
    );

    await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('冷却 5s'));
  });

  it('限流后进入冷却：冷却期内不再尝试开流', async () => {
    const ctx = setup({
      anchor: { chatId: '-100main', messageId: '777' },
      openImpl: async () => { throw new TelegramUserClientError('FLOOD_WAIT_30', 'flood', 30); },
    });

    await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' });
    ctx.userClient.openUserStream.mockClear();

    const second = await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' });

    expect(second).toBeNull();
    expect(ctx.userClient.openUserStream).not.toHaveBeenCalled();
  });

  it('账号槽位保持到流关闭：流未结束前不释放并发名额', async () => {
    // 用一个可控的流：不主动结束，验证第二次调用仍被并发上限拦住
    const { PassThrough } = require('stream') as typeof import('stream');
    let streamInstance!: InstanceType<typeof PassThrough>;
    const ctx = setup({
      anchor: { chatId: '-100main', messageId: '777' },
      // 把上限压到 2 便于构造「占满」：上限本身来自配置，见 currentMaxStreams
      maxStreams: 2,
      openImpl: async () => {
        streamInstance = new PassThrough();
        return { stream: streamInstance, size: 4 };
      },
    });

    const first = await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' });
    expect(first).not.toBeNull();

    // 流还没结束：同账号的第 3 次（上限 2）必须被拒，说明槽位没被提前释放
    const second = await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' });
    const third = await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' });
    expect(second).not.toBeNull();
    expect(third).toBeNull();

    // 流结束后名额归还
    second!.stream.resume();
    streamInstance.end();
    await new Promise((resolve) => setImmediate(resolve));
    const fourth = await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' });
    expect(fourth).not.toBeNull();
  });

  it('调用方已持上行租约时不再重复申请（避免同权重互等超时）', async () => {
    const ctx = setup({ anchor: { chatId: '-100main', messageId: '777' } });

    await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1', upstreamLeaseHeld: true });

    expect(ctx.resources.acquireUpstreamSlot).not.toHaveBeenCalled();
  });

  it('file 归属把当前源消息透传给锚点查询（拒绝旧版锚点）', async () => {
    const ctx = setup({ anchor: { chatId: '-100main', messageId: '777' } });

    await ctx.service.tryOpen({
      ownerType: 'file',
      ownerId: 'f1',
      expectedSourceMessageId: 'msg-2',
    });

    expect(ctx.anchors.findReadyAnchorForDownload).toHaveBeenCalledWith('file', 'f1', 'msg-2');
  });

  it('高权重账号占满时不直接回退，改用次高权重的空闲账号', async () => {
    // 高权重账号已经被占用到并发上限，低权重账号空闲——应当选后者，
    // 而不是因为「选中的那个满了」白白把用户 session 闲置、退回 Bot 链路。
    const accounts = [
      { id: 'user-high', externalId: '1', apiId: 1, apiHash: 'h', session: 's1', primaryChatId: null, weight: 10, capabilities: null },
      { id: 'user-low', externalId: '2', apiId: 2, apiHash: 'h', session: 's2', primaryChatId: null, weight: 1, capabilities: null },
    ];
    const { PassThrough } = require('stream') as typeof import('stream');
    const ctx = setup({
      accounts,
      anchor: { chatId: '-100main', messageId: '777' },
      maxStreams: 2,
      openImpl: async () => ({ stream: new PassThrough(), size: 4 }),
    });

    // 先用高权重账号开满 2 条流
    await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' });
    await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f2' });
    const openedIds = ctx.userClient.openUserStream.mock.calls.map(
      (call: unknown[]) => (call[0] as { apiId: number }).apiId,
    );
    expect(openedIds).toEqual([1, 1]);

    // 第 3 次：高权重已满，必须切到低权重账号而不是返回 null
    const third = await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f3' });
    expect(third).not.toBeNull();
    expect(ctx.userClient.openUserStream).toHaveBeenCalledTimes(3);
    const lastCall = ctx.userClient.openUserStream.mock.calls[2] as unknown[] | undefined;
    expect((lastCall?.[0] as { apiId: number } | undefined)?.apiId).toBe(2);
  });

  it('全部账号都占满时才回退 Bot 链路', async () => {
    // 单账号 + 上限 2：前两条占用，第三条必须返回 null
    const { PassThrough } = require('stream') as typeof import('stream');
    const ctx = setup({
      anchor: { chatId: '-100main', messageId: '777' },
      maxStreams: 2,
      openImpl: async () => ({ stream: new PassThrough(), size: 4 }),
    });

    expect(await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' })).not.toBeNull();
    expect(await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f2' })).not.toBeNull();
    expect(await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f3' })).toBeNull();
    expect(ctx.userClient.openUserStream).toHaveBeenCalledTimes(2);
  });

  it('无锚点时不占用账号并发名额（避免幽灵占位）', async () => {
    // 无锚点的文件是多数；若先占位再查锚点，两次无锚点调用就会把单账号占满，
    // 后续真正有锚点的下载反而被拒。
    let anchorResult: { chatId: string; messageId: string } | null = null;
    const ctx = setup({ anchor: null });
    ctx.anchors.findReadyAnchorForDownload.mockImplementation(async () => anchorResult);

    expect(await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' })).toBeNull();
    expect(await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f2' })).toBeNull();
    expect(await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f3' })).toBeNull();

    // 现在锚点可用：名额没有被前面三次无锚点调用吃掉
    anchorResult = { chatId: '-100main', messageId: '777' };
    expect(await ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f4' })).not.toBeNull();
    expect(ctx.userClient.openUserStream).toHaveBeenCalledTimes(1);
  });
});
