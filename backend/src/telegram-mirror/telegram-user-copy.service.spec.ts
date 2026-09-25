/**
 * 回归保护：唯一执行器的**账号粘性**、**幂等键**与**fail-closed**。
 *
 * 事故背景：
 * - `pickUser` 原用进程内游标轮转，同一任务每次重试可能换一个用户账号 → 换一个发送者
 *   重新复制一份（MTProto 的 `random_id` 去重是发送者维度的），最终在镜像群留下多份重复消息；
 * - 「转发成功」曾被当成「扩散完成」，因此本链路只允许报告**真实**成功，任何不确定都 blocked；
 * - 中继必须从**主群**出发（唯一中转落点）：源消息在原位置（私聊 / 账号存储群）时，
 *   先由持有该消息的 Bot 搬到主群，再从中继——这部分幂等由
 *   `TelegramMainChatAnchorService` 负责，本类只消费它的结果。
 */
import { TelegramUserCopyService } from './telegram-user-copy.service';
import { MirrorExecutionError } from './telegram-mirror.errors';

describe('TelegramUserCopyService（账号粘性与幂等键）', () => {
  const candidates = [
    { id: 'acc-a', apiId: 111, apiHash: 'hash-a', session: 'session-a', weight: 1 },
    { id: 'acc-b', apiId: 222, apiHash: 'hash-b', session: 'session-b', weight: 1 },
  ];

  function setup(options: {
    /** 源锚点（副本表登记的事实） */
    descriptor?: { chatId: string | null; messageId: string | null; fileSize: number };
    /** 主群锚点（默认：主群与源不同，说明发生过搬运） */
    anchor?: { chatId: string; messageId: string; planted: boolean };
    anchorError?: Error;
    userAccounts?: Array<{ id: string; apiId: number; apiHash: string; session: string; weight: number }>;
    copyError?: Error;
    userClientAvailable?: boolean;
    userClientReason?: string | null;
  } = {}) {
    const source = {
      describe: jest.fn(async () => options.descriptor
        ?? { chatId: '7001', messageId: '5', fileSize: 1024 }),
    };
    const anchors = {
      ensureAnchor: jest.fn(async () => {
        if (options.anchorError) throw options.anchorError;
        return options.anchor ?? { chatId: '-100999', messageId: '777', planted: true };
      }),
    };
    const accounts = {
      resolveEnabledUserAccounts: jest.fn(async () => options.userAccounts ?? candidates),
      markDegraded: jest.fn(async () => undefined),
    };
    const userClient = {
      isAvailable: () => options.userClientAvailable !== false,
      unavailableReason: () => options.userClientReason ?? null,
      copyMessage: jest.fn(async () => {
        if (options.copyError) throw options.copyError;
        return { targetChatId: '-100222', targetMessageId: '9201' };
      }),
    };

    const service = new TelegramUserCopyService(
      source as never,
      anchors as never,
      accounts as never,
      userClient as never,
    );
    return { service, source, anchors, accounts, userClient };
  }

  function task(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      ownerType: 'file',
      ownerId: 'file-1',
      sourceChatId: null,
      sourceMessageId: null,
      sourceAccountId: null,
      // 源内容版本（镜像任务幂等键的一部分；主群锚点据此识别覆盖上传）
      sourceVersion: 1,
      ...overrides,
    };
  }

  function rule(preferredAccountId: string | null = null, targetChatId = '-100222') {
    return { targetChatId, preferredAccountId };
  }

  it('中继固定从主群锚点出发（而不是源位置）', async () => {
    const ctx = setup({ descriptor: { chatId: '7001', messageId: '5', fileSize: 1024 } });

    await ctx.service.execute(task('task-aaa', { sourceAccountId: '1234567' }) as never, rule() as never);

    // 搬运请求携带的是「源事实」、「持有该消息的账号」与「源内容版本」
    // （版本供锚点识别覆盖上传，不能缺省或放宽）
    expect(ctx.anchors.ensureAnchor).toHaveBeenCalledWith({
      ownerType: 'file',
      ownerId: 'file-1',
      sourceChatId: '7001',
      sourceMessageId: '5',
      sourceAccountId: '1234567',
      sourceVersion: 1,
    });
    const calls = (ctx.userClient.copyMessage as jest.Mock).mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls[0][0].sourceChatId).toBe('-100999');
    expect(calls[0][0].sourceMessageId).toBe('777');
    expect(calls[0][0].targetChatId).toBe('-100222');
  });

  it('同一任务多次执行固定使用同一账号，且幂等键完全相同', async () => {
    const { service, userClient } = setup();

    await service.execute(task('task-aaa') as never, rule() as never);
    await service.execute(task('task-aaa') as never, rule() as never);

    const calls = (userClient.copyMessage as jest.Mock).mock.calls as unknown as Array<[Record<string, any>]>;
    expect(calls).toHaveLength(2);
    // 账号粘性：换账号等于换发送者，确定性 random_id 会因此失去去重作用
    expect(calls[0][0].credentials.apiId).toBe(calls[1][0].credentials.apiId);
    expect(calls[0][0].idempotencyKey).toBe(calls[1][0].idempotencyKey);
    // 幂等键必须包含任务、**镜像群**与执行账号：缺镜像群时，多镜像群共用同一
    // random_id，服务端会按去重返回另一个群的消息 ID，定位与实际位置不一致
    expect(String(calls[0][0].idempotencyKey)).toMatch(/^task-aaa:-100222:(acc-a|acc-b)$/);
  });

  it('同一文件在不同镜像群的任务幂等键不同（各自独立去重）', async () => {
    const { service, userClient } = setup();

    await service.execute(task('task-aaa') as never, rule(null, '-100222') as never);
    await service.execute(task('task-aaa') as never, rule(null, '-100333') as never);

    const keys = ((userClient.copyMessage as jest.Mock).mock.calls as unknown as Array<[Record<string, any>]>)
      .map((call) => call[0].idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toBe('task-aaa:-100222:acc-a');
    expect(keys[1]).toBe('task-aaa:-100333:acc-a');
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

  it('成功结果按目标消息 ID 回填（回执锚点不可为空，且不写副本表用的 file_id）', async () => {
    const { service } = setup();

    const result = await service.execute(task('task-aaa') as never, rule() as never);

    expect(result).toMatchObject({
      targetChatId: '-100222',
      targetMessageId: '9201',
      targetTelegramFileId: '',
      mode: 'user_copy',
    });
  });

  it('账号凭据失效时标记该账号 degraded 并抛出（让管理员可见）', async () => {
    const failure = Object.assign(new Error('AUTH_KEY_UNREGISTERED'), { name: 'TelegramUserClientError', kind: 'auth' });
    const ctx = setup({ copyError: failure, userAccounts: [candidates[0]] });

    await expect(ctx.service.execute(task('task-aaa') as never, rule() as never)).rejects.toBe(failure);

    expect(ctx.accounts.markDegraded).toHaveBeenCalledWith('acc-a', 'user_session_invalid', expect.stringContaining('AUTH_KEY'));
  });

  it('MTProto 客户端不可用时 blocked（不降级、不静默跳过）', async () => {
    const ctx = setup({ userClientAvailable: false, userClientReason: '未安装依赖' });

    await expect(ctx.service.execute(task('task-aaa') as never, rule() as never))
      .rejects.toMatchObject({ code: 'user_client_unavailable', kind: 'blocked' });
    expect(ctx.userClient.copyMessage).not.toHaveBeenCalled();
  });

  it('没有可用用户账号时 blocked', async () => {
    const ctx = setup({ userAccounts: [] });

    await expect(ctx.service.execute(task('task-aaa') as never, rule() as never))
      .rejects.toMatchObject({ code: 'no_user_account', kind: 'blocked' });
    expect(ctx.userClient.copyMessage).not.toHaveBeenCalled();
  });

  it('镜像群未配置时 blocked（不把空 chat id 交给 MTProto）', async () => {
    const ctx = setup();

    await expect(ctx.service.execute(task('task-aaa') as never, rule(null, '') as never))
      .rejects.toMatchObject({ code: 'target_chat_missing', kind: 'blocked' });
    expect(ctx.userClient.copyMessage).not.toHaveBeenCalled();
  });

  it('主群搬运失败时不执行中继（前置失败直接向上抛）', async () => {
    const anchorFailure = Object.assign(new Error('CHAT_WRITE_FORBIDDEN'), { name: 'TelegramAccountError', kind: 'unavailable' });
    const ctx = setup({ anchorError: anchorFailure });

    await expect(ctx.service.execute(task('task-aaa') as never, rule() as never)).rejects.toBe(anchorFailure);

    expect(ctx.userClient.copyMessage).not.toHaveBeenCalled();
  });

  it('源事实读取失败时轮次必须收口（否则永久停在「进行中」）', async () => {
    // 事故形态：轮次先开立，随后 describe() 抛错——若不收口，轮次停在 planned/active，
    // 后台时间线长期显示「进行中」，且后续 beginRound 会误判为可合并而不再新建。
    const failure = new MirrorExecutionError('source_file_missing', '站内文件不存在', 'blocked');
    const attempts = {
      beginRound: jest.fn(async () => ({ attempt: { id: 'att-1' } })),
      markRelaySucceeded: jest.fn(),
      finishBlocked: jest.fn(async () => undefined),
    };
    const service = new TelegramUserCopyService(
      { describe: jest.fn(async () => { throw failure; }) } as never,
      { ensureAnchor: jest.fn() } as never,
      { resolveEnabledUserAccounts: jest.fn() } as never,
      { isAvailable: () => true, unavailableReason: () => null, copyMessage: jest.fn() } as never,
      attempts as never,
    );

    await expect(service.execute(task('task-aaa') as never, rule() as never)).rejects.toBe(failure);

    expect(attempts.finishBlocked).toHaveBeenCalledWith('att-1', expect.objectContaining({
      status: 'blocked_source_anchor',
      failureReason: 'source_missing',
    }));
  });

  it('用户账号列表读取失败时轮次同样收口（异常不允许留在轮次之外）', async () => {
    const attempts = {
      beginRound: jest.fn(async () => ({ attempt: { id: 'att-2' } })),
      markRelaySucceeded: jest.fn(),
      finishBlocked: jest.fn(async () => undefined),
    };
    const service = new TelegramUserCopyService(
      { describe: jest.fn(async () => ({ chatId: '7001', messageId: '5', fileSize: 1 })) } as never,
      { ensureAnchor: jest.fn(async () => ({ chatId: '-100999', messageId: '777', planted: true })) } as never,
      { resolveEnabledUserAccounts: jest.fn(async () => { throw new Error('db down'); }) } as never,
      { isAvailable: () => true, unavailableReason: () => null, copyMessage: jest.fn() } as never,
      attempts as never,
    );

    await expect(service.execute(task('task-aaa') as never, rule() as never)).rejects.toThrow('db down');

    expect(attempts.finishBlocked).toHaveBeenCalledWith('att-2', expect.objectContaining({
      status: 'retryable_failed',
    }));
  });
});
