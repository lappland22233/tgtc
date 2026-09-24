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
      { count: jest.fn(async () => 0), findOne: jest.fn(async () => null) } as never,
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

/**
 * 主群解析（副本扩散唯一中转落点）。
 *
 * 事故形态：多条启用规则配置了不同的源群时，若「挑第一条继续跑」，
 * 同一份文件会按不同中转落点被搬运多次（主群锚点表的共享语义失效），
 * 且后台看不出「到底是哪个群」。因此冲突必须显式失败。
 */
describe('TelegramMirrorConfigService（主群解析与多规则启用）', () => {
  function setup(rules: Array<Record<string, unknown>>) {
    const repo = {
      find: jest.fn(async (options?: { where?: { enabled?: boolean } }) => (
        options?.where?.enabled ? rules.filter((rule) => rule.enabled) : rules
      )),
      findOne: jest.fn(async ({ where }: { where: { id?: string } }) => (
        rules.find((rule) => rule.id === where.id) ?? null
      )),
      create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
      save: jest.fn(async (value: Record<string, unknown>) => value),
      update: jest.fn(async () => ({ affected: 1 })),
      delete: jest.fn(async () => ({ affected: 1 })),
    };
    const service = new TelegramMirrorConfigService(
      repo as never,
      { count: jest.fn(async () => 0) } as never,
      { list: jest.fn(async () => ({ items: [] })), findById: jest.fn(async () => null) } as never,
      { getChat: jest.fn(async () => ({ title: 'ok', type: 'supergroup' })) } as never,
      { isAvailable: () => false, unavailableReason: () => 'test' } as never,
      { log: jest.fn() } as never,
    );
    return { service, repo };
  }

  it('没有启用规则时判为 main_chat_missing', async () => {
    const ctx = setup([{ id: 'r1', enabled: false, sourceChatId: '-100999' }]);

    await expect(ctx.service.resolveMainChatId()).resolves.toMatchObject({ ok: false, code: 'main_chat_missing' });
  });

  it('启用规则未配置源群时判为 main_chat_missing', async () => {
    const ctx = setup([{ id: 'r1', enabled: true, sourceChatId: '' }]);

    await expect(ctx.service.resolveMainChatId()).resolves.toMatchObject({ ok: false, code: 'main_chat_missing' });
  });

  it('启用规则源群不一致时判为 main_chat_conflict（不猜第一条）', async () => {
    const ctx = setup([
      { id: 'r1', enabled: true, sourceChatId: '-100999' },
      { id: 'r2', enabled: true, sourceChatId: '-100777' },
    ]);

    const result = await ctx.service.resolveMainChatId();
    expect(result).toMatchObject({ ok: false, code: 'main_chat_conflict' });
    expect((result as { summary: string }).summary).toContain('-100999');
    expect((result as { summary: string }).summary).toContain('-100777');
  });

  it('多条启用规则共用同一主群时解析成功（多镜像群形态）', async () => {
    const ctx = setup([
      { id: 'r1', enabled: true, sourceChatId: '-100999', targetChatId: '-100222' },
      { id: 'r2', enabled: true, sourceChatId: '-100999', targetChatId: '-100333' },
    ]);

    await expect(ctx.service.resolveMainChatId()).resolves.toEqual({ ok: true, chatId: '-100999' });
  });

  it('启用规则时拒绝「主群与其它启用规则不一致」（避免多中转落点）', async () => {
    const ctx = setup([
      {
        id: 'r1',
        enabled: true,
        sourceChatId: '-100999',
        targetChatId: '-100222',
        lastTestStatus: 'ok',
        name: 'A',
      },
      {
        id: 'r2',
        enabled: false,
        sourceChatId: '-100777',
        targetChatId: '-100333',
        lastTestStatus: 'ok',
        name: 'B',
      },
    ]);

    await expect(ctx.service.setEnabled('r2', true, 'admin-1'))
      .rejects.toThrow(/主群必须与其它启用规则一致/);
  });

  it('启用规则时要求先通过权限测试（避免打开开关后批量 blocked）', async () => {
    const ctx = setup([
      {
        id: 'r1',
        enabled: false,
        sourceChatId: '-100999',
        targetChatId: '-100222',
        lastTestStatus: 'untested',
        name: 'A',
      },
    ]);

    await expect(ctx.service.setEnabled('r1', true, 'admin-1')).rejects.toThrow(/权限测试/);
  });

  it('删除启用中的规则被拒绝（避免在途任务失去目标）', async () => {
    const ctx = setup([
      { id: 'r1', enabled: true, sourceChatId: '-100999', targetChatId: '-100222', name: 'A' },
    ]);

    await expect(ctx.service.removeRule('r1', 'admin-1')).rejects.toThrow(/先停用再删除/);
  });

  it('删除仍有在途任务的规则被拒绝（不把正在扩散变成静默中断）', async () => {
    const rules = [{ id: 'r1', enabled: false, sourceChatId: '-100999', targetChatId: '-100222', name: 'A' }];
    const repo = {
      find: jest.fn(async () => rules),
      findOne: jest.fn(async () => rules[0]),
      create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
      save: jest.fn(async (value: Record<string, unknown>) => value),
      update: jest.fn(async () => ({ affected: 1 })),
      delete: jest.fn(async () => ({ affected: 1 })),
    };
    const service = new TelegramMirrorConfigService(
      repo as never,
      { count: jest.fn(async () => 3) } as never,
      { list: jest.fn(async () => ({ items: [] })), findById: jest.fn(async () => null) } as never,
      {} as never,
      { isAvailable: () => false } as never,
      { log: jest.fn() } as never,
    );

    await expect(service.removeRule('r1', 'admin-1')).rejects.toThrow(/还有 3 个在途任务/);
    expect(repo.delete).not.toHaveBeenCalled();
  });
});
