import { UserRelayService } from './user-relay.service';

/**
 * 用户账号中继的**能力判定与目标群解析**回归保护。
 *
 * 关键语义（改动前请先读这些断言）：
 * - 能力判定只依赖两个**同步可得**的事实（开关 + MTProto 客户端可加载），
 *   刻意不把「已有可用用户账号」纳入（异步查库事实会让冷缓存时误报「未配置」）；
 * - 目标群**唯一权威是启用中的镜像规则**：绝不回退归档群——归档群没有经过
 *   「全部 Bot 可见」校验，用它当中继目标会表现为「转发成功但无人认领」；
 * - 规则仓库不可用/未装配时返回空串且不抛错，由调用方收口为 `blocked_target_chat`；
 * - 本服务**不执行转发**：唯一执行器是 `TelegramUserCopyService`（守卫
 *   `no-strategy-a-guard.spec.ts` 会挡住「执行原语回流」）。
 */
describe('UserRelayService（中继能力判定与目标群解析）', () => {
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
    };
    const rules = { findOne: jest.fn(async () => (ruleTarget ? { targetChatId: ruleTarget } : null)) };
    const service = new UserRelayService(
      configService as never,
      userClient as never,
      (options.rulesAvailable === false ? null : rules) as never,
    );
    return { service, userClient, configService, rules };
  }

  it('开关未开启时 isConfigured=false、isEnabledByConfig=false', () => {
    const ctx = setup({});

    expect(ctx.service.isConfigured()).toBe(false);
    expect(ctx.service.isEnabledByConfig()).toBe(false);
  });

  it('MTProto 客户端不可用时 isConfigured=false（fail-closed，不伪装已配置）', () => {
    const ctx = setup();
    ctx.userClient.isAvailable.mockReturnValue(false);
    ctx.userClient.unavailableReason.mockReturnValue('teleproto 未安装');

    expect(ctx.service.isConfigured()).toBe(false);
    // 「已开启开关」与「可用」是两个事实，报告与排障需要分别看到
    expect(ctx.service.isEnabledByConfig()).toBe(true);
  });

  it('开关已开且客户端可用时 isConfigured=true', () => {
    const ctx = setup();

    expect(ctx.service.isConfigured()).toBe(true);
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
});
