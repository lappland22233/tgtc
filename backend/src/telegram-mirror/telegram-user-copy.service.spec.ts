/**
 * 回归保护：无源复制的**账号粘性**与**幂等键**。
 *
 * 事故背景：`pickUser` 原用进程内游标轮转，同一任务每次重试可能换一个用户账号 → 换一个
 * 发送者重新复制一份（MTProto 的 `random_id` 去重是发送者维度的），再叠加「服务端已复制
 * 成功但返回结果里没有消息 ID」被当成可重试失败，最终在备份群留下多份重复消息。
 */
import { TelegramUserCopyService } from './telegram-user-copy.service';

describe('TelegramUserCopyService（账号粘性与幂等键）', () => {
  const candidates = [
    { id: 'acc-a', apiId: 111, apiHash: 'hash-a', session: 'session-a', weight: 1 },
    { id: 'acc-b', apiId: 222, apiHash: 'hash-b', session: 'session-b', weight: 1 },
  ];

  function setup(options: {
    /** 源锚点（默认群消息，即用户账号可直接读取） */
    descriptor?: { chatId: string | null; messageId: string | null; fileSize: number };
    sourceAccountId?: string | null;
    archiveChatId?: string;
    /** 规则里的源群（私聊来源的搬运中转群） */
    ruleSourceChatId?: string;
    taskSourceChatId?: string | null;
    taskSourceMessageId?: string | null;
    panelAccounts?: Array<{ id: string; accountId: string; token: string }>;
  } = {}) {
    const source = {
      describe: jest.fn(async () => options.descriptor
        ?? { chatId: '-100111', messageId: '5', fileSize: 1024 }),
    };
    const accounts = {
      resolveEnabledUserAccounts: jest.fn(async () => candidates),
      markDegraded: jest.fn(async () => undefined),
      resolveEnabledBotAccounts: jest.fn(async () => options.panelAccounts ?? []),
    };
    const userClient = {
      isAvailable: () => true,
      unavailableReason: () => null,
      copyMessage: jest.fn(async () => ({ targetChatId: '-100222', targetMessageId: '9201' })),
    };
    const client = {
      forwardMessage: jest.fn(async () => ({ messageId: '777' })),
    };
    const pool = {
      getConfig: jest.fn((id: string) => (id === '1234567'
        ? { id, token: '1234567:SECRET', chatId: '-100111', weight: 1, maxInflight: 8, enabled: true }
        : null)),
    };
    const env: Record<string, string> = { TELEGRAM_BOT_TOKEN: '1234567:AAAA' };
    if (options.archiveChatId) env.TELEGRAM_ARCHIVE_CHAT_ID = options.archiveChatId;
    const configService = { get: jest.fn((key: string) => env[key]) };
    const tasks = { update: jest.fn(async () => ({ affected: 1 })) };

    const service = new TelegramUserCopyService(
      source as never,
      accounts as never,
      userClient as never,
      client as never,
      pool as never,
      configService as never,
      tasks as never,
    );
    return { service, userClient, client, pool, configService, tasks, accounts };
  }

  function task(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      ownerType: 'file',
      ownerId: 'file-1',
      sourceChatId: null,
      sourceMessageId: null,
      sourceAccountId: null,
      ...overrides,
    };
  }

  function rule(preferredAccountId: string | null = null, sourceChatId = '') {
    return { targetChatId: '-100222', preferredAccountId, sourceChatId };
  }

  it('同一任务多次执行固定使用同一账号，且幂等键完全相同', async () => {
    const { service, userClient } = setup();

    await service.execute(task('task-aaa') as never, rule() as never);
    await service.execute(task('task-aaa') as never, rule() as never);

    const calls = (userClient.copyMessage as jest.Mock).mock.calls as unknown as Array<[Record<string, any>]>;
    expect(calls).toHaveLength(2);
    // 账号粘性：换账号等于换发送者，确定性 random_id 会因此失去去重作用
    expect(calls[0][0].credentials.apiId).toBe(calls[1][0].credentials.apiId);
    expect(calls[0][0].idempotencyKey).toBe(calls[1][0].idempotencyKey);
    // 幂等键必须包含任务、目标群与执行账号：服务端去重与人工排查都依赖它，
    // 缺目标群时「规则在重试期间被改」会让同一 random_id 指向旧群的消息
    expect(String(calls[0][0].idempotencyKey)).toMatch(/^task-aaa:-100222:(acc-a|acc-b)$/);
  });

  it('不同任务的幂等键不同（不会互相顶掉对方的复制）', async () => {
    const { service, userClient } = setup();

    await service.execute(task('task-aaa') as never, rule() as never);
    await service.execute(task('task-bbb') as never, rule() as never);

    const keys = ((userClient.copyMessage as jest.Mock).mock.calls as unknown as Array<[Record<string, any>]>)
      .map((call) => call[0].idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('规则指定优先账号时优先使用（不受稳定 hash 影响）', async () => {
    const { service, userClient } = setup();

    await service.execute(task('task-aaa') as never, rule('acc-b') as never);

    const calls = (userClient.copyMessage as jest.Mock).mock.calls as unknown as Array<[Record<string, any>]>;
    const call = calls[0][0];
    expect(call.credentials.apiId).toBe(222);
    expect(call.idempotencyKey).toBe('task-aaa:-100222:acc-b');
  });

  it('成功结果按目标消息 ID 回填（回执锚点不可为空）', async () => {
    const { service } = setup();

    const result = await service.execute(task('task-aaa') as never, rule() as never);

    expect(result).toMatchObject({ targetChatId: '-100222', targetMessageId: '9201', mode: 'user_copy' });
  });

  /**
   * Bot 私聊来源的搬运。
   *
   * 事故背景：`grant` 类来源的源锚点是「Bot 与用户的私聊」，**用户账号读不到该会话**，
   * 直接转发必然 permission 失败；而「Bot 收到文件」正是产品要覆盖的入口之一。
   */
  describe('Bot 私聊来源的搬运（用户账号不可读的会话）', () => {
    it('先由接收 Bot 把私聊消息搬到中转群，再用中转消息作为源锚点并写回任务行', async () => {
      const ctx = setup({
        descriptor: { chatId: '7001', messageId: '5', fileSize: 1024 },
        ruleSourceChatId: '-100111',
      });
      const mirrorTask = task('task-priv', { sourceAccountId: '1234567' });

      await ctx.service.execute(mirrorTask as never, rule(null, '-100111') as never);

      expect(ctx.client.forwardMessage).toHaveBeenCalledWith('1234567', '1234567:SECRET', '-100111', '7001', '5');
      // 锚点固化：Bot API forwardMessage 没有幂等键，重试必须复用中转消息而不是再搬一次
      expect(ctx.tasks.update).toHaveBeenCalledWith(
        { id: 'task-priv' },
        { sourceChatId: '-100111', sourceMessageId: '777' },
      );
      const calls = (ctx.userClient.copyMessage as jest.Mock).mock.calls as unknown as Array<[Record<string, unknown>]>;
      expect(calls[0][0].sourceChatId).toBe('-100111');
      expect(calls[0][0].sourceMessageId).toBe('777');
    });

    it('已在群里的源锚点不触发搬运（保持零字节转发语义）', async () => {
      const ctx = setup({ descriptor: { chatId: '-100111', messageId: '5', fileSize: 1024 } });

      await ctx.service.execute(task('task-group') as never, rule() as never);

      expect(ctx.client.forwardMessage).not.toHaveBeenCalled();
      expect(ctx.tasks.update).not.toHaveBeenCalled();
    });

    it('规则未配置源群时回退 TELEGRAM_ARCHIVE_CHAT_ID 作为中转群', async () => {
      const ctx = setup({
        descriptor: { chatId: '7001', messageId: '5', fileSize: 1024 },
        archiveChatId: '-100888',
      });

      await ctx.service.execute(task('task-priv') as never, rule() as never);

      // sourceAccountId 缺失（单账号部署）时回退默认 Bot 的 Token，不猜测其它账号
      expect(ctx.client.forwardMessage).toHaveBeenCalledWith(
        '1234567', '1234567:AAAA', '-100888', '7001', '5',
      );
    });

    it('没有可用中转群时 blocked（明确失败，绝不允许报告成功）', async () => {
      const ctx = setup({ descriptor: { chatId: '7001', messageId: '5', fileSize: 1024 } });

      await expect(ctx.service.execute(task('task-priv') as never, rule() as never))
        .rejects.toMatchObject({ code: 'relay_staging_chat_missing' });
      expect(ctx.userClient.copyMessage).not.toHaveBeenCalled();
    });

    it('中转群与备份群相同时 blocked（Bot 转发进备份群无法达成副本认领）', async () => {
      const ctx = setup({
        descriptor: { chatId: '7001', messageId: '5', fileSize: 1024 },
        archiveChatId: '-100222',
      });

      await expect(ctx.service.execute(task('task-priv') as never, rule() as never))
        .rejects.toMatchObject({ code: 'relay_staging_chat_conflict' });
    });

    it('无法确认接收 Bot 的凭据时 blocked（绝不跨账号代搬）', async () => {
      const ctx = setup({
        descriptor: { chatId: '7001', messageId: '5', fileSize: 1024 },
        ruleSourceChatId: '-100111',
      });
      ctx.pool.getConfig.mockReturnValue(null as never);

      await expect(
        ctx.service.execute(
          task('task-priv', { sourceAccountId: '9999999' }) as never,
          rule(null, '-100111') as never,
        ),
      ).rejects.toMatchObject({ code: 'relay_forward_bot_unresolved' });
      expect(ctx.client.forwardMessage).not.toHaveBeenCalled();
    });
  });
});
