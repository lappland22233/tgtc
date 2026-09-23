import { TelegramMirrorConfigService } from './telegram-mirror-config.service';

/**
 * 备份群集合（`listTargetChatIds`）回归保护。
 *
 * 事故背景：缓存判据曾写反为「未命中缓存才返回缓存」，导致该方法**永远返回空数组且永不查库**。
 * 它被入站链路用于判定「消息是否来自备份群」，失效后备份群内每条消息都会被群内每个 Bot
 * 各转发一次到归档群，消息量与上游调用按 Bot 数放大——且因为方法本身「正常返回」，
 * 日志上完全看不出异常。
 */
describe('TelegramMirrorConfigService（备份群集合与缓存）', () => {
  function setup(repoOverrides: Record<string, unknown> = {}) {
    const repo = {
      find: jest.fn(async () => [
        { targetChatId: '-100222' },
        { targetChatId: '-100333' },
        { targetChatId: '-100222' },
        { targetChatId: '  ' },
        { targetChatId: null },
      ]),
      findOne: jest.fn(async () => null),
      create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
      save: jest.fn(async (value: Record<string, unknown>) => value),
      update: jest.fn(async () => ({ affected: 1 })),
      ...repoOverrides,
    };
    const service = new TelegramMirrorConfigService(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
      { log: jest.fn() } as never,
    );
    return { service, repo };
  }

  it('首次调用即查库返回去重后的备份群集合（缓存判据不得写反）', async () => {
    const ctx = setup();

    const ids = await ctx.service.listTargetChatIds();

    expect(ctx.repo.find).toHaveBeenCalledTimes(1);
    expect(ids).toEqual(['-100222', '-100333']);
  });

  it('TTL 内命中缓存不重复查库（入站判定是热路径）', async () => {
    const ctx = setup();

    await ctx.service.listTargetChatIds();
    const second = await ctx.service.listTargetChatIds();

    expect(ctx.repo.find).toHaveBeenCalledTimes(1);
    expect(second).toEqual(['-100222', '-100333']);
  });

  it('冷缓存读取失败：返回空集合且不刷新时间戳，下一轮立即重试', async () => {
    const ctx = setup();
    ctx.repo.find.mockRejectedValueOnce(new Error('db down') as never);

    await expect(ctx.service.listTargetChatIds()).resolves.toEqual([]);
    // 时间戳未被刷新（仍为 0）→ 下一次调用必须真的重试，而不是把空集合缓存住
    await expect(ctx.service.listTargetChatIds()).resolves.toEqual(['-100222', '-100333']);
    expect(ctx.repo.find).toHaveBeenCalledTimes(2);
  });

  it('缓存过期后重新查库；此次读取失败时沿用上一次结果', async () => {
    jest.useFakeTimers();
    try {
      const ctx = setup();
      await ctx.service.listTargetChatIds();
      // 超过 TTL（30s）→ 必须重新查库，而不是继续返回可能过期的缓存
      jest.advanceTimersByTime(31_000);
      ctx.repo.find.mockRejectedValueOnce(new Error('db down') as never);

      await expect(ctx.service.listTargetChatIds()).resolves.toEqual(['-100222', '-100333']);
      expect(ctx.repo.find).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('没有任何规则时返回空集合（不误判为备份群）', async () => {
    const ctx = setup({ find: jest.fn(async () => []) });

    await expect(ctx.service.listTargetChatIds()).resolves.toEqual([]);
  });
});
