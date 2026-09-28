import { TelegramAccountError } from './telegram-account-client.service';
import { RelayCapabilityService } from './relay-capability.service';

/**
 * 中继能力快照与预检回归保护。
 *
 * 关键语义（改动前请先读这些断言）：
 * - **默认 dry-run 绝不产生 Telegram 消息**：预检是发布前的常规动作，误发消息会在
 *   目标群留下垃圾并可能触发限流；
 * - 「未检查」必须与「通过」「失败」三态区分：把没检查过渲染成绿色等于伪造健康态；
 * - 出参必须脱敏（不返回 Token、session、完整 chat id）；
 * - 探测有上限：Bot 逐个 2 次 API 调用，不设上限会在账号多时打爆 Bot API。
 */
describe('RelayCapabilityService（能力快照与预检）', () => {
  const accounts = [
    { id: 'acc-a', apiId: 111, apiHash: 'hash-a', session: 'session-a', weight: 1 },
  ];

  function setup(options: {
    relayEnabled?: boolean;
    clientAvailable?: boolean;
    clientReason?: string | null;
    userAccounts?: typeof accounts;
    targetChatId?: string;
    sourceChatId?: string | null;
    botAccounts?: Array<{ id: string; enabled: boolean }>;
    meInfo?: (accountId: string) => { ok: boolean; botId: string | null; canReadAllGroupMessages: boolean | null; error?: string };
    chatMember?: () => { status: string; canPostMessages: boolean | null };
    chatAccess?: () => { chatId: string; title?: string; type: string; canWrite: boolean };
    sendMessage?: () => Promise<void>;
  } = {}) {
    const relay = {
      isEnabledByConfig: jest.fn(() => options.relayEnabled ?? true),
      resolveTargetChatId: jest.fn(async () => options.targetChatId ?? '-100222'),
    };
    const userClient = {
      isAvailable: jest.fn(() => options.clientAvailable ?? true),
      unavailableReason: jest.fn(() => options.clientReason ?? null),
      checkChatAccess: jest.fn(async () => (options.chatAccess
        ? options.chatAccess()
        : { chatId: '-100111', title: '源群', type: 'Channel', canWrite: true })),
    };
    const directory = { listEnabled: jest.fn(async () => options.userAccounts ?? accounts) };
    const botAccounts = options.botAccounts ?? [{ id: 'bot-1', enabled: true }];
    const pool = {
      snapshot: jest.fn(() => ({
        enabled: true,
        inactiveReason: null,
        counters: {} as never,
        accounts: botAccounts.map((bot) => ({
          id: bot.id,
          enabled: bot.enabled,
          storageConfigured: true,
        })) as never[],
      })),
      getConfig: jest.fn((id: string) => ({ id, token: `${id}:TOKEN`, chatId: '-1001' })),
    };
    const accountClient = {
      getMeInfo: jest.fn(async (accountId: string) => (options.meInfo
        ? options.meInfo(accountId)
        : { ok: true, botId: '777', canReadAllGroupMessages: true })),
      getChatMember: jest.fn(async () => (options.chatMember
        ? options.chatMember()
        : { status: 'administrator', canPostMessages: true })),
      sendMessage: jest.fn(options.sendMessage ?? (async () => undefined)),
    };
    const rules = {
      findOne: jest.fn(async () => (options.sourceChatId === null
        ? null
        : { sourceChatId: options.sourceChatId ?? '-100111', targetChatId: options.targetChatId ?? '-100222' })),
    };

    const service = new RelayCapabilityService(
      relay as never,
      userClient as never,
      directory as never,
      pool as never,
      accountClient as never,
      rules as never,
    );
    return { service, relay, userClient, directory, pool, accountClient, rules };
  }

  it('dry-run 预检：只做只读检查，绝不发送任何 Telegram 消息', async () => {
    const ctx = setup();

    const report = await ctx.service.preflight();

    expect(report.dryRun).toBe(true);
    expect(report.sentTestMessage).toBe(false);
    expect(ctx.accountClient.sendMessage).not.toHaveBeenCalled();
    expect(report.status).toBe('ok');
    const writable = report.checks.find((item) => item.id === 'target_chat_writable');
    expect(writable?.status).toBe('not_checked');
    expect(writable?.advice).toContain('dryRun=false');
  });

  it('dryRun=false 才发送受控测试消息，并显式声明已产生消息', async () => {
    const ctx = setup();

    const report = await ctx.service.preflight({ dryRun: false, testMessage: '预检测试' });

    expect(ctx.accountClient.sendMessage).toHaveBeenCalledWith(
      'bot-1',
      'bot-1:TOKEN',
      '-100222',
      '预检测试',
      { disableNotification: true },
    );
    expect(report.sentTestMessage).toBe(true);
    expect(report.checks.find((item) => item.id === 'target_chat_writable')?.detail).toContain('已产生 Telegram 消息');
  });

  it('默认测试消息也带「可忽略」提示（避免群成员误解）', async () => {
    const ctx = setup();

    await ctx.service.preflight({ dryRun: false });

    const call = (ctx.accountClient.sendMessage as jest.Mock).mock.calls[0] as unknown[];
    expect(String(call[3])).toContain('副本扩散预检');
    expect(String(call[3])).toContain('可忽略');
  });

  it('前置条件逐项给出可执行建议：开关关闭 / 客户端不可用 / 无用户账号 / 无目标群', async () => {
    const ctx = setup({
      relayEnabled: false,
      clientAvailable: false,
      clientReason: 'teleproto 未安装',
      userAccounts: [],
      targetChatId: '',
    });

    const report = await ctx.service.preflight();

    expect(report.status).toBe('failed');
    const byId = new Map(report.checks.map((item) => [item.id, item]));
    expect(byId.get('config')?.advice).toContain('重启');
    expect(byId.get('user_client')?.detail).toContain('teleproto');
    expect(byId.get('user_accounts')?.advice).toContain('授权');
    // 目标群唯一权威是启用中的镜像规则：建议里不能再出现「归档群回退」
    expect(byId.get('target_chat')?.advice).toContain('归档群不再作为回退目标');
  });

  it('Bot 隐私模式未关闭时判定失败并给出处理建议（转发成功但无人认领的根因）', async () => {
    const ctx = setup({
      meInfo: () => ({ ok: true, botId: '777', canReadAllGroupMessages: false }),
    });

    const report = await ctx.service.preflight();

    const bots = report.checks.find((item) => item.id === 'bots_can_receive');
    expect(bots?.status).toBe('failed');
    expect(bots?.detail).toContain('隐私模式未关闭');
    expect(bots?.advice).toContain('BotFather');
  });

  it('Bot 不在目标群内时判定失败（成员查询报错翻译为可读原因）', async () => {
    const ctx = setup({
      chatMember: () => {
        throw new TelegramAccountError('Bad Request: chat not found', 'bot-1', 'other', 400);
      },
    });

    const report = await ctx.service.preflight();

    const bots = report.checks.find((item) => item.id === 'bots_can_receive');
    expect(bots?.status).toBe('failed');
    expect(bots?.detail).toContain('不在目标群内');
  });

  it('Bot 状态为 left/kicked 时判定失败（成员查询成功但不具备接收能力）', async () => {
    const ctx = setup({ chatMember: () => ({ status: 'left', canPostMessages: null }) });

    const report = await ctx.service.preflight();

    expect(report.checks.find((item) => item.id === 'bots_can_receive')?.detail).toContain('不在目标群内');
  });

  it('源群不可读时判定失败（用户账号未加入源群）', async () => {
    const ctx = setup({
      chatAccess: () => {
        throw new Error('CHAT_FORBIDDEN');
      },
    });

    const report = await ctx.service.preflight();

    const source = report.checks.find((item) => item.id === 'source_chat_readable');
    expect(source?.status).toBe('failed');
    expect(source?.advice).toContain('源群');
  });

  it('客户端不可用时不谎报源群结论（记「未检查」而不是「通过」）', async () => {
    const ctx = setup({ clientAvailable: false });

    const report = await ctx.service.preflight();

    expect(report.checks.find((item) => item.id === 'source_chat_readable')?.status).toBe('not_checked');
    expect(ctx.userClient.checkChatAccess).not.toHaveBeenCalled();
  });

  it('能力快照：未探测时 checkStatus=not_checked，探测后按结论汇总', async () => {
    const ctx = setup();

    const before = ctx.service.snapshot();
    expect(before.checkStatus).toBe('not_checked');
    expect(before.checkedAt).toBeNull();

    await ctx.service.preflight();
    const after = ctx.service.snapshot();
    expect(after.checkStatus).toBe('partial'); // dry-run 下「目标群可写」未检查
    expect(after.checkedAt).not.toBeNull();
    expect(after.sourceChatReadable).toBe('ok');
    expect(after.botsCanReceiveRelay).toBe('ok');
    expect(after.targetChatWritable).toBe('not_checked');
  });

  it('快照与报告全部脱敏：不出现 Token / session / 完整 chat id', async () => {
    const ctx = setup();

    const report = await ctx.service.preflight();
    const snapshot = ctx.service.snapshot();
    const serialized = JSON.stringify({ report, snapshot });

    expect(serialized).not.toContain('bot-1:TOKEN');
    expect(serialized).not.toContain('session-a');
    expect(serialized).not.toContain('hash-a');
    expect(serialized).not.toContain('-100222');
    expect(report.targetChatPreview).toBe('***0222');
  });

  it('refreshFacts 读不到规则时保留上次事实并置空目标群（不抛错）', async () => {
    const ctx = setup({ targetChatId: '' });
    ctx.rules.findOne.mockRejectedValue(new Error('db down') as never);

    await expect(ctx.service.refreshFacts()).resolves.toBeUndefined();
    expect(ctx.service.snapshot().resolvedTargetChatIdPreview).toBeNull();
  });

  it('Bot 探测有上限：账号数量再多也只探测前 N 个', async () => {
    const many = Array.from({ length: 25 }, (_value, index) => ({ id: `bot-${index}`, enabled: true }));
    const ctx = setup({ botAccounts: many });

    await ctx.service.preflight();

    // 每个 Bot 2 次调用（getMe + getChatMember）；上限 10 → 最多 20 次
    expect((ctx.accountClient.getMeInfo as jest.Mock).mock.calls.length).toBeLessThanOrEqual(10);
  });
});
