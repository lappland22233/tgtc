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

  function setup() {
    const source = {
      describe: jest.fn(async () => ({ chatId: '-100111', messageId: '5', fileSize: 1024 })),
    };
    const accounts = {
      resolveEnabledUserAccounts: jest.fn(async () => candidates),
      markDegraded: jest.fn(async () => undefined),
    };
    const userClient = {
      isAvailable: () => true,
      unavailableReason: () => null,
      copyMessage: jest.fn(async () => ({ targetChatId: '-100222', targetMessageId: '9201' })),
    };
    const service = new TelegramUserCopyService(source as never, accounts as never, userClient as never);
    return { service, userClient };
  }

  function task(id: string) {
    return {
      id,
      ownerType: 'file',
      ownerId: 'file-1',
      sourceChatId: null,
      sourceMessageId: null,
    };
  }

  function rule(preferredAccountId: string | null = null) {
    return { targetChatId: '-100222', preferredAccountId };
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
    // 幂等键必须包含任务与执行账号，服务端去重与人工排查都依赖它
    expect(String(calls[0][0].idempotencyKey)).toMatch(/^task-aaa:(acc-a|acc-b)$/);
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
    expect(call.idempotencyKey).toBe('task-aaa:acc-b');
  });

  it('成功结果按目标消息 ID 回填（回执锚点不可为空）', async () => {
    const { service } = setup();

    const result = await service.execute(task('task-aaa') as never, rule() as never);

    expect(result).toMatchObject({ targetChatId: '-100222', targetMessageId: '9201', mode: 'user_copy' });
  });
});
