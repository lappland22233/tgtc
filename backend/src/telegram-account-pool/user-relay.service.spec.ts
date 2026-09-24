import { TelegramUserClientError, TelegramUserFailureKind } from '../telegram-user/telegram-user-client.service';
import { UserRelayService } from './user-relay.service';

/**
 * 用户账号中继（**策略 B：副本扩散的唯一执行方式**）回归保护。
 *
 * 关键语义（改动前请先读这些断言）：
 * - 未开启/不可用/无账号/源不可读/目标群未配一律返回**标准化可诊断失败**，绝不伪装成功；
 * - 失败原因必须落在固定枚举内（告警阈值、后台 Top N 与重试策略都按分类聚合），
 *   自由文本会让同一类故障散成几十个键，统计与告警全部失效；
 * - 目标群**唯一权威是启用中的镜像规则**：不再回退归档群（归档群没有经过
 *   「全部 Bot 可见」校验，用它当中继目标会表现为「转发成功但无人认领」）；
 * - 选号必须**确定性**（同一幂等键 → 同一账号 + 同一 `idempotencyKey`），
 *   否则 MTProto 的 `random_id`（去重维度是发送者账号）失效，重试会在副本群留下重复消息；
 * - 凭据（session / apiHash）绝不进入返回值与错误摘要。
 */
describe('UserRelayService（用户账号中继）', () => {
  const accounts = [
    { id: 'acc-a', apiId: 111, apiHash: 'hash-a', session: 'session-a', weight: 1 },
    { id: 'acc-b', apiId: 222, apiHash: 'hash-b', session: 'session-b', weight: 1 },
  ];

  function setup(
    env: Record<string, string> = { TELEGRAM_USER_RELAY_ENABLED: 'true' },
    ruleTarget: string | null = null,
    options: { rulesAvailable?: boolean } = {},
  ) {
    const configService = {
      get: jest.fn((key: string) => env[key]),
    };
    const userClient = {
      isAvailable: jest.fn(() => true),
      unavailableReason: jest.fn((): string | null => null),
      copyMessage: jest.fn(async () => ({ targetChatId: '-100222', targetMessageId: '9001' })),
    };
    const directory = {
      listEnabled: jest.fn(async () => accounts),
      markDegraded: jest.fn(async () => undefined),
      cachedCount: jest.fn(() => accounts.length),
    };
    const pool = { bumpCounter: jest.fn() };
    const rules = { findOne: jest.fn(async () => (ruleTarget ? { targetChatId: ruleTarget } : null)) };
    const service = new UserRelayService(
      configService as never,
      userClient as never,
      directory as never,
      pool as never,
      (options.rulesAvailable === false ? null : rules) as never,
    );
    return { service, userClient, directory, pool, configService, rules };
  }

  const request = { sourceChatId: '-100111', sourceMessageId: '5', targetChatId: '-100222' };

  it('开关未开启时返回 not_configured，且不触碰 MTProto、不计入失败', async () => {
    const ctx = setup({});

    const result = await ctx.service.relay(request);

    expect(ctx.service.isConfigured()).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_configured');
    expect(ctx.userClient.copyMessage).not.toHaveBeenCalled();
    // 「中继未开启」是明确的产品状态而非故障：计入失败会让关闭中继的部署一直报故障
    expect(ctx.pool.bumpCounter).not.toHaveBeenCalledWith('relayFailed');
    expect(ctx.pool.bumpCounter).not.toHaveBeenCalledWith('relayAttempts');
  });

  it('MTProto 客户端不可用时返回 client_unavailable（fail-closed，不伪装已配置）', async () => {
    const ctx = setup();
    ctx.userClient.isAvailable.mockReturnValue(false);
    ctx.userClient.unavailableReason.mockReturnValue('teleproto 未安装');

    const result = await ctx.service.relay(request);

    expect(ctx.service.isConfigured()).toBe(false);
    expect(result).toMatchObject({ ok: false, reason: 'client_unavailable' });
    expect(result.detail).toContain('teleproto');
    // 计数：否则「已配置但完全不可用」在告警面板上无声（启动预检只告警不阻断）
    expect(ctx.pool.bumpCounter).toHaveBeenCalledWith('relayAttempts');
    expect(ctx.pool.bumpCounter).toHaveBeenCalledWith('relayFailed');
  });

  it('缺少源消息定位时返回 source_missing（不允许随机挑账号尝试）', async () => {
    const ctx = setup();

    const result = await ctx.service.relay({ ...request, sourceMessageId: '' });

    expect(result).toMatchObject({ ok: false, reason: 'source_missing' });
    expect(ctx.directory.listEnabled).not.toHaveBeenCalled();
  });

  it('缺少目标群时返回 target_missing（并计入中继失败）', async () => {
    const ctx = setup();

    const result = await ctx.service.relay({ ...request, targetChatId: '' });

    expect(result).toMatchObject({ ok: false, reason: 'target_missing' });
    expect(ctx.pool.bumpCounter).toHaveBeenCalledWith('relayFailed');
    expect(ctx.userClient.copyMessage).not.toHaveBeenCalled();
  });

  it('resolveTargetChatId 取启用中镜像规则的目标群（唯一权威）', async () => {
    const ctx = setup({ TELEGRAM_USER_RELAY_ENABLED: 'true', TELEGRAM_ARCHIVE_CHAT_ID: '-100999' }, '-100222');

    await expect(ctx.service.resolveTargetChatId()).resolves.toBe('-100222');
  });

  it('resolveTargetChatId 无启用规则时返回空串：绝不回退归档群', async () => {
    const ctx = setup({ TELEGRAM_USER_RELAY_ENABLED: 'true', TELEGRAM_ARCHIVE_CHAT_ID: '-100999' });

    // 归档群只是审计转发目的地，成员与权限没经过「全部 Bot 可见」校验；
    // 用它当中继目标会「转发成功但无人认领」，副本数长期为 0 而日志全是成功
    await expect(ctx.service.resolveTargetChatId()).resolves.toBe('');
  });

  it('resolveTargetChatId 在规则仓库不可用时返回空串且不抛错（由调用方收口为 blocked_target_chat）', async () => {
    const ctx = setup({ TELEGRAM_USER_RELAY_ENABLED: 'true', TELEGRAM_ARCHIVE_CHAT_ID: '-100999' });
    ctx.rules.findOne.mockRejectedValue(new Error('db down') as never);

    await expect(ctx.service.resolveTargetChatId()).resolves.toBe('');
  });

  it('resolveTargetChatId 在规则仓库未装配时返回空串（单测/非池化部署）', async () => {
    const ctx = setup({ TELEGRAM_USER_RELAY_ENABLED: 'true' }, null, { rulesAvailable: false });

    await expect(ctx.service.resolveTargetChatId()).resolves.toBe('');
  });

  it('没有可用用户账号时返回 no_account 并计入中继失败', async () => {
    const ctx = setup();
    ctx.directory.listEnabled.mockResolvedValue([]);

    const result = await ctx.service.relay(request);

    expect(result).toMatchObject({ ok: false, reason: 'no_account' });
    expect(ctx.pool.bumpCounter).toHaveBeenCalledWith('relayFailed');
  });

  it('成功中继：返回目标消息 ID 与执行账号，并计入 relaySucceeded', async () => {
    const ctx = setup();

    const result = await ctx.service.relay(request);

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe('9001');
    expect(result.accountId).toMatch(/^acc-(a|b)$/);
    expect(ctx.pool.bumpCounter).toHaveBeenCalledWith('relayAttempts');
    expect(ctx.pool.bumpCounter).toHaveBeenCalledWith('relaySucceeded');
    const calls = (ctx.userClient.copyMessage as jest.Mock).mock.calls as unknown as Array<[Record<string, unknown>]>;
    const call = calls[0][0];
    expect(call.sourceChatId).toBe('-100111');
    expect(call.sourceMessageId).toBe('5');
    expect(call.targetChatId).toBe('-100222');
  });

  it('选号确定性：同一幂等键两次中继 → 同一账号 + 同一 idempotencyKey', async () => {
    const ctx = setup();

    await ctx.service.relay(request);
    await ctx.service.relay(request);

    const calls = (ctx.userClient.copyMessage as jest.Mock).mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].idempotencyKey).toBe(calls[1][0].idempotencyKey);
    expect((calls[0][0].credentials as { apiId: number }).apiId)
      .toBe((calls[1][0].credentials as { apiId: number }).apiId);
    // 幂等键必须包含执行账号，服务端去重与人工排查都依赖它
    expect(String(calls[0][0].idempotencyKey)).toMatch(/:acc-(a|b)$/);
  });

  it('默认幂等种子包含目标群：同一源消息中继到不同群不共用 random_id', async () => {
    const ctx = setup();

    await ctx.service.relay({ ...request });
    await ctx.service.relay({ ...request, targetChatId: '-100333' });

    const calls = (ctx.userClient.copyMessage as jest.Mock).mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls[0][0].targetChatId).toBe('-100222');
    expect(calls[1][0].targetChatId).toBe('-100333');
    // 共用同一个 random_id 会让服务端按去重返回旧消息 ID，把目标位置报错
    expect(calls[0][0].idempotencyKey).not.toBe(calls[1][0].idempotencyKey);
  });

  it('显式幂等键同样并入目标群（调用方无法替代目标群区分）', async () => {
    const ctx = setup();

    await ctx.service.relay({ ...request, idempotencyKey: 'copy:file:file-1' });
    await ctx.service.relay({ ...request, idempotencyKey: 'copy:file:file-1', targetChatId: '-100333' });

    const calls = (ctx.userClient.copyMessage as jest.Mock).mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(String(calls[0][0].idempotencyKey)).toContain('copy:file:file-1:-100222');
    expect(String(calls[1][0].idempotencyKey)).toContain('copy:file:file-1:-100333');
  });

  it('规则指定优先账号可用时优先使用，不再按权重回落', async () => {
    const ctx = setup();

    const result = await ctx.service.relay({ ...request, preferredAccountId: 'acc-b' });

    expect(result.accountId).toBe('acc-b');
    const calls = (ctx.userClient.copyMessage as jest.Mock).mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(String(calls[0][0].idempotencyKey)).toBe('-100111:5:-100222:acc-b');
  });

  it.each<[TelegramUserFailureKind, string]>([
    ['permission', 'permission_denied'],
    ['auth', 'auth_invalid'],
    ['not_found', 'source_missing'],
    ['flood', 'rate_limited'],
    ['network', 'network'],
    ['unsupported', 'unknown'],
    ['unverified', 'unknown'],
    ['other', 'unknown'],
  ])('MTProto 失败分类映射：kind=%s → reason=%s（告警与重试策略的唯一口径）', async (kind, expected) => {
    const ctx = setup();
    ctx.userClient.copyMessage.mockRejectedValue(new TelegramUserClientError(`boom-${kind}`, kind));

    const result = await ctx.service.relay(request);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(expected);
    expect(ctx.pool.bumpCounter).toHaveBeenCalledWith('relayFailed');
  });

  it('权限类失败不误标记账号降级（那是群权限问题，不是凭据失效）', async () => {
    const ctx = setup();
    ctx.userClient.copyMessage.mockRejectedValue(
      new TelegramUserClientError('用户账号无法访问 chat ***0111（未加入该群或 chat 标识错误）', 'permission'),
    );

    const result = await ctx.service.relay(request);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('permission_denied');
    expect(result.detail).toContain('permission');
    expect(ctx.directory.markDegraded).not.toHaveBeenCalled();
  });

  it('凭据失效（auth）时标记账号降级，让管理员可见并可重新授权', async () => {
    const ctx = setup();
    ctx.userClient.copyMessage.mockRejectedValue(
      new TelegramUserClientError('SESSION_REVOKED', 'auth'),
    );

    const result = await ctx.service.relay(request);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('auth_invalid');
    expect(ctx.directory.markDegraded).toHaveBeenCalledWith(
      expect.stringMatching(/^acc-(a|b)$/),
      'user_session_invalid',
      expect.any(String),
    );
  });

  it('返回值与错误摘要中绝不出现 session / apiHash', async () => {
    const ctx = setup();
    ctx.userClient.copyMessage.mockRejectedValue(new Error('boom session-a leaked hash-a'));

    const result = await ctx.service.relay(request);

    expect(JSON.stringify(result)).not.toContain('session-a');
    expect(JSON.stringify(result)).not.toContain('hash-a');
    // 未知异常不回传原文（避免把凭据带出内存），只给可诊断的固定摘要
    expect(result.detail).toContain('详见后端日志');
  });
});
