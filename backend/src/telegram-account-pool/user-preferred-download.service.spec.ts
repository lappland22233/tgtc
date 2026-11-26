import { Readable } from 'stream';
import { UserPreferredDownloadService } from './user-preferred-download.service';
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
    acquireUpstreamSlot: jest.fn(async () => {
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
    expect(ctx.anchors.findReadyAnchorForDownload).toHaveBeenCalledWith('file', 'f1');
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

  it('上行预算不足：直接回退，不开流', async () => {
    const ctx = setup({
      anchor: { chatId: '-100main', messageId: '777' },
      slotRejects: true,
    });

    await expect(ctx.service.tryOpen({ ownerType: 'file', ownerId: 'f1' })).resolves.toBeNull();
    expect(ctx.userClient.openUserStream).not.toHaveBeenCalled();
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
});
