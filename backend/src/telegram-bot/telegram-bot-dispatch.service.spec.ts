import { TelegramBotDispatchService } from './telegram-bot-dispatch.service';
import type { TelegramUpdate } from '../telegram/telegram.types';

type Counters = {
  selections: number;
  failovers: number;
  fallbacks: number;
  unresolved: number;
  replicationsOk: number;
  replicationsFailed: number;
  streamFailures: number;
  replyFailures: number;
  inboundRegistrationFailures: number;
  userRelaysOk: number;
  userRelaysFailed: number;
  inboundBridgeMisses: number;
};

function makeCounters(): Counters {
  return {
    selections: 0,
    failovers: 0,
    fallbacks: 0,
    unresolved: 0,
    replicationsOk: 0,
    replicationsFailed: 0,
    streamFailures: 0,
    replyFailures: 0,
    inboundRegistrationFailures: 0,
    userRelaysOk: 0,
    userRelaysFailed: 0,
    inboundBridgeMisses: 0,
  };
}

function makePool(active: boolean) {
  const counters = makeCounters();
  return {
    counters,
    isActive: jest.fn(() => active),
    ids: jest.fn(() => ['1234567', '7654321']),
    getConfig: jest.fn((id: string) => ({
      id,
      token: `${id}:SECRET`,
      chatId: '-100111',
      weight: 1,
      maxInflight: 8,
      enabled: true,
    })),
    bumpCounter: jest.fn((key: keyof Counters, delta = 1) => {
      counters[key] += delta;
    }),
    countersSnapshot: jest.fn(() => ({ ...counters })),
  };
}

function makeMessageUpdate(overrides: {
  text?: string;
  document?: Record<string, unknown> | null;
  chatType?: string;
  chatId?: number;
} = {}): TelegramUpdate {
  const message: Record<string, unknown> = {
    message_id: 100,
    chat: { id: overrides.chatId ?? 7001, type: overrides.chatType ?? 'private' },
    from: { id: 7001, first_name: 'User', username: 'user' },
  };
  if (overrides.text !== undefined) message.text = overrides.text;
  if (overrides.document !== null) {
    message.document = overrides.document ?? {
      file_id: 'FILE-1',
      file_unique_id: 'UNIQ-1',
      file_name: 'report.pdf',
      mime_type: 'application/pdf',
      file_size: 1024,
    };
  }
  return { update_id: 1, message } as unknown as TelegramUpdate;
}

function makeService(options: {
  pool?: ReturnType<typeof makePool> | null;
  copies?: {
    upsertReady: jest.Mock;
    bridgeInboundCopyToLogicalFile?: jest.Mock;
  } | null;
  accountClient?: { sendMessage: jest.Mock; forwardMessage: jest.Mock } | null;
  archiveChatId?: string;
  defaultBotToken?: string;
  issueMock?: jest.Mock;
  /** 镜像备份群集合（用于验证「来自备份群的消息不再归档转发」） */
  mirrorTargetChatIds?: string[];
}) {
  const counters = makeCounters();
  const pool = options.pool === undefined ? null : options.pool;
  const copies = options.copies
    ? {
        bridgeInboundCopyToLogicalFile: jest.fn(async () => ({ bridged: false, matchedFileIds: [] })),
        ...options.copies,
      }
    : null;
  const mirrorConfig = options.mirrorTargetChatIds
    ? { listTargetChatIds: jest.fn(async () => options.mirrorTargetChatIds) }
    : null;
  const telegramService = { sendMessage: jest.fn(async () => ({ message_id: 1, chat: { id: 7001 } })) };
  const botConfigService = {
    getConfig: jest.fn(async () => ({
      linkTtlHours: 4,
      dailyLimit: 5,
      quotaTimezone: 'Asia/Shanghai',
      linkDomainMode: 'manual',
      linkDomain: 'https://files.example.com',
    })),
    resolveSiteOriginAsync: jest.fn(async () => 'https://files.example.com'),
  };
  const quotaService = {
    isWhitelisted: jest.fn(async () => false),
    getBusinessDate: jest.fn(() => '2026-09-21'),
    getUsed: jest.fn(async () => 1),
    consume: jest.fn(async () => ({ allowed: true, used: 1 })),
    refund: jest.fn(async () => undefined),
  };
  const issueMock = options.issueMock ?? jest.fn(async (input: { sourceAccountId?: string | null }) => ({
    grant: {
      id: 'grant-1',
      tokenPrefix: 'tgl_aaaaaaaa',
      expiresAt: new Date(Date.now() + 3600_000),
      sourceAccountId: input.sourceAccountId ?? null,
    },
    token: 'TOKEN',
  }));
  const grantService = {
    findByMessage: jest.fn(async () => null),
    issue: issueMock,
    buildUrl: jest.fn((origin: string, token: string) => `${origin}/api/bot-dl/${token}`),
    isActive: jest.fn(() => true),
    replayToken: jest.fn(() => 'TOKEN'),
  };
  const adminService = {
    isAdmin: jest.fn(() => true),
    auditCommandDenied: jest.fn(),
    addWhitelist: jest.fn(async () => ({ created: true })),
    removeWhitelist: jest.fn(async () => true),
    listWhitelist: jest.fn(async () => []),
    queryLinks: jest.fn(async () => []),
    revokeByToken: jest.fn(async () => ({ ok: true })),
  };
  const auditService = { log: jest.fn() };
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'TELEGRAM_ARCHIVE_CHAT_ID') return options.archiveChatId ?? '';
      if (key === 'TELEGRAM_BOT_TOKEN') return options.defaultBotToken ?? '1234567:AAAA';
      return '';
    }),
  };

  const service = new TelegramBotDispatchService(
    telegramService as never,
    botConfigService as never,
    quotaService as never,
    grantService as never,
    adminService as never,
    auditService as never,
    pool as never,
    copies as never,
    (options.accountClient ?? null) as never,
    configService as never,
    null,
    mirrorConfig as never,
  );

  return {
    service,
    counters,
    telegramService,
    botConfigService,
    quotaService,
    grantService,
    adminService,
    auditService,
    configService,
    pool,
    copies,
    mirrorConfig,
  };
}

describe('TelegramBotDispatchService（多 Bot 身份链路）', () => {
  it('池化模式：命令由「收到消息的账号」回复，且不使用默认账号', async () => {
    const pool = makePool(true);
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({ pool, accountClient });

    await ctx.service.handleUpdate(makeMessageUpdate({ text: '/help' }), { accountId: '1234567' });

    expect(accountClient.sendMessage).toHaveBeenCalledWith(
      '1234567',
      '1234567:SECRET',
      '7001',
      expect.stringContaining('/help'),
      { replyToMessageId: 100 },
    );
    expect(ctx.telegramService.sendMessage).not.toHaveBeenCalled();
  });

  it('池化模式：按账号回复失败时绝不改用默认账号代发，只记计数', async () => {
    const pool = makePool(true);
    const accountClient = {
      sendMessage: jest.fn(async () => { throw new Error('429 Too Many Requests'); }),
      forwardMessage: jest.fn(),
    };
    const ctx = makeService({ pool, accountClient });

    await ctx.service.handleUpdate(makeMessageUpdate({ text: '/quota' }), { accountId: '1234567' });

    expect(ctx.telegramService.sendMessage).not.toHaveBeenCalled();
    expect(pool.counters.replyFailures).toBe(1);
  });

  it('池化模式下账号配置解析失败时放弃回复（绝不回退默认账号）', async () => {
    const pool = makePool(true);
    pool.getConfig.mockReturnValue(null as never);
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({ pool, accountClient });

    await ctx.service.handleUpdate(makeMessageUpdate({ text: '/help' }), { accountId: '1234567' });

    expect(accountClient.sendMessage).not.toHaveBeenCalled();
    expect(ctx.telegramService.sendMessage).not.toHaveBeenCalled();
    expect(pool.counters.replyFailures).toBe(1);
  });

  it('非池化模式：回复保持原单账号链路（telegramService.sendMessage）', async () => {
    const pool = makePool(false);
    const ctx = makeService({ pool });

    await ctx.service.handleUpdate(makeMessageUpdate({ text: '/help' }));

    expect(ctx.telegramService.sendMessage).toHaveBeenCalledWith(
      '7001',
      expect.any(String),
      { replyToMessageId: 100 },
    );
  });

  it('池化模式：签发直链记录收到消息的账号为 sourceAccountId，并登记该账号副本', async () => {
    const pool = makePool(true);
    const copies = { upsertReady: jest.fn(async () => ({})) };
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({ pool, copies, accountClient });

    await ctx.service.handleUpdate(makeMessageUpdate(), { accountId: '1234567' });

    expect(copies.upsertReady).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: 'fileUnique',
      ownerId: 'UNIQ-1',
      accountId: '1234567',
      telegramFileId: 'FILE-1',
      source: 'inbound',
    }));
    expect(ctx.grantService.issue).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAccountId: '1234567', telegramFileId: 'FILE-1' }),
      4,
    );
  });

  it('单账号模式：签发时记录默认 Token 的 botId 作为源账号', async () => {
    const ctx = makeService({ defaultBotToken: '9876543:BBBB' });

    await ctx.service.handleUpdate(makeMessageUpdate());

    expect(ctx.grantService.issue).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAccountId: '9876543' }),
      4,
    );
  });

  it('缺少 file_unique_id：拒绝副本登记（不退化为 file_id）并计数', async () => {
    const pool = makePool(true);
    const copies = { upsertReady: jest.fn(async () => ({})) };
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({ pool, copies, accountClient });

    await ctx.service.handleUpdate(
      makeMessageUpdate({ document: { file_id: 'FILE-9', file_name: 'x.bin' } }),
      { accountId: '1234567' },
    );

    expect(copies.upsertReady).not.toHaveBeenCalled();
    expect(pool.counters.inboundRegistrationFailures).toBe(1);
  });

  it('群/频道消息（用户账号中继）：登记本账号副本并用本账号转发归档群', async () => {
    const pool = makePool(true);
    const copies = { upsertReady: jest.fn(async () => ({})) };
    const accountClient = {
      sendMessage: jest.fn(async () => undefined),
      forwardMessage: jest.fn(async () => ({ messageId: '555' })),
    };
    const ctx = makeService({ pool, copies, accountClient, archiveChatId: '-100999' });

    await ctx.service.handleUpdate(
      makeMessageUpdate({ chatType: 'group', chatId: -100555 }),
      { accountId: '1234567' },
    );

    expect(copies.upsertReady).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 'UNIQ-1',
      accountId: '1234567',
    }));
    expect(accountClient.forwardMessage).toHaveBeenCalledWith(
      '1234567',
      '1234567:SECRET',
      '-100999',
      '-100555',
      '100',
    );
    // 群消息不回复、不扣配额
    expect(accountClient.sendMessage).not.toHaveBeenCalled();
    expect(ctx.quotaService.consume).not.toHaveBeenCalled();
  });

  it('入站副本桥接到站内逻辑文件：桥接入参与副本记录完全一致（含 file_id 归属）', async () => {
    const pool = makePool(true);
    const bridge = jest.fn(async () => ({ bridged: true, matchedFileIds: ['file-1'] }));
    const copies = { upsertReady: jest.fn(async () => ({})), bridgeInboundCopyToLogicalFile: bridge };
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({ pool, copies, accountClient });

    await ctx.service.handleUpdate(
      makeMessageUpdate({ chatType: 'group', chatId: -100777 }),
      { accountId: '1234567' },
    );

    // 桥接缺失时下载选号（按 ownerType='file' 查副本）看不到这些副本，负载均衡无从发生
    expect(bridge).toHaveBeenCalledWith({
      fileUniqueId: 'UNIQ-1',
      accountId: '1234567',
      telegramFileId: 'FILE-1',
      chatId: '-100777',
      messageId: '100',
      fileSize: 1024,
    });
    // 命中站内文件 → 不计入「未命中」
    expect(pool.counters.inboundBridgeMisses).toBe(0);
  });

  it('桥接未命中站内文件（群消息与站内无关）时只计数，不影响副本登记', async () => {
    const pool = makePool(true);
    const copies = {
      upsertReady: jest.fn(async () => ({})),
      bridgeInboundCopyToLogicalFile: jest.fn(async () => ({ bridged: false, matchedFileIds: [] })),
    };
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({ pool, copies, accountClient });

    await ctx.service.handleUpdate(
      makeMessageUpdate({ chatType: 'group', chatId: -100777 }),
      { accountId: '1234567' },
    );

    expect(copies.upsertReady).toHaveBeenCalled();
    expect(pool.counters.inboundBridgeMisses).toBe(1);
    expect(pool.counters.inboundRegistrationFailures).toBe(0);
  });

  it('来自镜像备份群的消息：登记副本但**不再归档转发**（抑制 N 倍放大）', async () => {
    const pool = makePool(true);
    const copies = { upsertReady: jest.fn(async () => ({})) };
    const accountClient = {
      sendMessage: jest.fn(async () => undefined),
      forwardMessage: jest.fn(async () => ({ messageId: '555' })),
    };
    const ctx = makeService({
      pool,
      copies,
      accountClient,
      archiveChatId: '-100999',
      mirrorTargetChatIds: ['-100777'],
    });

    await ctx.service.handleUpdate(
      makeMessageUpdate({ chatType: 'group', chatId: -100777 }),
      { accountId: '1234567' },
    );

    expect(copies.upsertReady).toHaveBeenCalled();
    expect(accountClient.forwardMessage).not.toHaveBeenCalled();
  });

  it('未启用池化时不登记副本（保持原行为）', async () => {
    const pool = makePool(false);
    const copies = { upsertReady: jest.fn(async () => ({})) };
    const ctx = makeService({ pool, copies });

    await ctx.service.handleUpdate(makeMessageUpdate(), { accountId: '1234567' });

    expect(copies.upsertReady).not.toHaveBeenCalled();
  });

  it('域名未配置：提示由原账号回复且不扣配额', async () => {
    const pool = makePool(true);
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({ pool, copies: { upsertReady: jest.fn(async () => ({})) }, accountClient });
    ctx.botConfigService.resolveSiteOriginAsync.mockResolvedValueOnce('');

    await ctx.service.handleUpdate(makeMessageUpdate(), { accountId: '1234567' });

    expect(ctx.quotaService.consume).not.toHaveBeenCalled();
    expect(accountClient.sendMessage).toHaveBeenCalledWith(
      '1234567',
      '1234567:SECRET',
      '7001',
      expect.stringContaining('域名'),
      { replyToMessageId: 100 },
    );
  });
});
