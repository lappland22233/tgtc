import { Readable } from 'stream';
import { existsSync } from 'fs';
import { TelegramBotDispatchService } from './telegram-bot-dispatch.service';
import type { TelegramUpdate } from '../telegram/telegram.types';
import type { TelegramBotInboundTask } from '../common/entities/telegram-bot-inbound-task.entity';
import type { EnqueueInboundTask, InboundNotice, TelegramBotInboundQueueService } from './telegram-bot-inbound-queue.service';
import type { IssuedGrant } from './telegram-bot-grant.service';
import type { EntityManager } from 'typeorm';
import { TelegramAccountError } from '../telegram-account-pool/telegram-account-client.service';

type Counters = {
  selections: number;
  failovers: number;
  fallbacks: number;
  unresolved: number;
  streamFailures: number;
  replyFailures: number;
  inboundRegistrationFailures: number;
  relayAttempts: number;
  relaySucceeded: number;
  relayFailed: number;
  relayClaimsMissed: number;
  inboundBridgeMisses: number;
};

function makeCounters(): Counters {
  return {
    selections: 0,
    failovers: 0,
    fallbacks: 0,
    unresolved: 0,
    streamFailures: 0,
    replyFailures: 0,
    inboundRegistrationFailures: 0,
    relayAttempts: 0,
    relaySucceeded: 0,
    relayFailed: 0,
    relayClaimsMissed: 0,
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
  messageId?: number;
  text?: string;
  document?: Record<string, unknown> | null;
  chatType?: string;
  chatId?: number;
} = {}): TelegramUpdate {
  const message: Record<string, unknown> = {
    message_id: overrides.messageId ?? 100,
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

/** 频道帖：以 `channel_post` 到达（镜像群/主群可能是频道），且没有 `from` 用户 */
function makeChannelPostUpdate(overrides: {
  document?: Record<string, unknown> | null;
  chatId?: number;
} = {}): TelegramUpdate {
  const message: Record<string, unknown> = {
    message_id: 200,
    chat: { id: overrides.chatId ?? -1007001, type: 'channel' },
  };
  if (overrides.document !== null) {
    message.document = overrides.document ?? {
      file_id: 'CH-FILE-1',
      file_unique_id: 'CH-UNIQ-1',
      file_name: 'video.mp4',
      mime_type: 'video/mp4',
      file_size: 2048,
    };
  }
  return { update_id: 2, channel_post: message } as unknown as TelegramUpdate;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 2_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timeout');
}

const queueTimers: NodeJS.Timeout[] = [];
afterEach(() => { queueTimers.splice(0).forEach(clearInterval); });

function makeService(options: {
  pool?: ReturnType<typeof makePool> | null;
  copies?: {
    upsertReady: jest.Mock;
    bridgeInboundCopyToLogicalFile?: jest.Mock;
  } | null;
  accountClient?: { sendMessage: jest.Mock; forwardMessage: jest.Mock; editMessageText?: jest.Mock } | null;
  archiveChatId?: string;
  defaultBotToken?: string;
  issueMock?: jest.Mock;
  /** 镜像备份群集合（用于验证「来自备份群的消息不再归档转发」） */
  mirrorTargetChatIds?: string[];
  /** 启用中镜像规则目标群（= 中继目标群；用于验证 relayed 标注口径） */
  enabledMirrorTargetChatIds?: string[];
  /** 扩散轮次回写替身 */
  attempts?: { recordClaim: jest.Mock } | null;
  /** `findByFileUniqueId` 的命中结果（grant 命名空间归因用） */
  grantMatches?: Array<{ id: string }>;
  botConfig?: Record<string, unknown>;
  storageRouter?: {
    availableBackendTypes: jest.Mock;
    upload: jest.Mock;
    deleteRemoteObject?: jest.Mock;
  } | null;
  accountPoolDownload?: {
    isActive: jest.Mock;
    hasAccount: jest.Mock;
    openSourceStream: jest.Mock;
  } | null;
  downloadResources?: {
    reserve: jest.Mock;
    extendDiskReservation?: jest.Mock;
  } | null;
  uploadDiskBudget?: {
    isStrictMode: jest.Mock;
    acquireSession: jest.Mock;
    releaseSession: jest.Mock;
  } | null;
  transferTracker?: {
    register: jest.Mock;
    isTransferActive?: jest.Mock;
  } | null;
}) {
  const counters = makeCounters();
  const pool = options.pool === undefined ? null : options.pool;
  const copies = options.copies
    ? {
        bridgeInboundCopyToLogicalFile: jest.fn(async () => ({ bridged: false, matchedFileIds: [] })),
        ...options.copies,
      }
    : null;
  const mirrorConfig = (options.mirrorTargetChatIds || options.enabledMirrorTargetChatIds)
    ? {
        listTargetChatIds: jest.fn(async () => options.mirrorTargetChatIds ?? []),
        listEnabledTargetChatIds: jest.fn(async () => options.enabledMirrorTargetChatIds ?? []),
      }
    : null;
  const attempts = options.attempts === undefined
    ? { recordClaim: jest.fn(async () => undefined) }
    : options.attempts;
  const telegramService = {
    sendMessage: jest.fn(async () => ({ message_id: 1, chat: { id: 7001 } })),
    editMessageText: jest.fn(async () => true),
    getRealtimeFileStream: jest.fn(async () => ({
      stream: Readable.from([Buffer.from('hello world test data')]),
      info: { file_id: 'FILE-1', file_path: '/tmp/f', file_size: 21 },
    })),
  };
  const botConfigService = {
    getConfig: jest.fn(async () => ({
      linkTtlHours: 4,
      dailyLimit: 5,
      quotaTimezone: 'Asia/Shanghai',
      linkDomainMode: 'manual',
      linkDomain: 'https://files.example.com',
      storageMode: 'telegram',
      ...options.botConfig,
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
  const issueMock = options.issueMock ?? jest.fn(async (input: { sourceAccountId?: string | null; fileUniqueId?: string | null }) => ({
    grant: {
      id: 'grant-1',
      tokenPrefix: 'tgl_aaaaaaaa',
      expiresAt: new Date(Date.now() + 3600_000),
      sourceAccountId: input.sourceAccountId ?? null,
      fileUniqueId: input.fileUniqueId ?? null,
    },
    token: 'TOKEN',
  }));
  const grantService = {
    findByMessage: jest.fn(async () => null),
    // 跨群认领归因：默认无命中；用例可经 grantMatches 注入命中结果
    findByFileUniqueId: jest.fn(async () => options.grantMatches ?? []),
    issue: issueMock,
    attachGDriveCache: jest.fn(async () => true),
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

  const tasks: TelegramBotInboundTask[] = [];
  const queuedGrants = new Map<string, IssuedGrant>();
  const findByMessage = (botId: string, chatId: string, messageId: string) =>
    tasks.find((task) => task.receiverBotId === botId && task.chatId === chatId && task.messageId === messageId) ?? null;
  const inboundQueue = {
    tasks,
    findByMessage: jest.fn(async (...args: Parameters<typeof findByMessage>) => findByMessage(...args)),
    isBanned: jest.fn(async () => false),
    withUnbannedUser: jest.fn(async (_id: string, action: (manager?: EntityManager) => Promise<unknown>) => action()),
    enqueue: jest.fn(async (input: EnqueueInboundTask) => {
      const found = findByMessage(input.receiverBotId, input.chatId, input.messageId);
      if (found) return { status: 'duplicate', task: found, used: found.quotaUsed };
      const quota = await quotaService.consume();
      const now = new Date();
      const task: TelegramBotInboundTask = {
        ...input, id: String(tasks.length + 1), sequence: tasks.length + 1, status: 'queued',
        waitingMsgId: null, noticeStatus: null, noticePosition: null, nextNoticeAt: null,
        noticeLeaseUntil: null, botCooldownUntil: null, availableAt: null, failureReason: null,
        quotaUsed: quota.used, quotaConsumed: true, leaseToken: null, leaseExpiresAt: null, grantId: null,
        createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
      };
      tasks.push(task);
      return { status: 'queued', task, used: quota.used };
    }),
    claimNext: jest.fn(async (botId: string) => {
      if (tasks.some((task) => task.receiverBotId === botId && task.leaseToken)) return null;
      const head = tasks.find((task) => task.receiverBotId === botId && task.status === 'queued');
      if (!head || (head.availableAt && head.availableAt > new Date())) return null;
      Object.assign(head, { status: 'running', leaseToken: 'lease' });
      return { ...head };
    }),
    renew: jest.fn(async (task: TelegramBotInboundTask) =>
      tasks.some((row) => row.id === task.id && row.status === 'running')),
    complete: jest.fn(async (task: TelegramBotInboundTask, action: (manager?: EntityManager) => Promise<IssuedGrant>) => {
      const row = tasks.find((entry) => entry.id === task.id)!;
      if (row.status !== 'running') return null;
      const issued = await action();
      queuedGrants.set(issued.grant.id, issued);
      Object.assign(row, { status: 'completed', grantId: issued.grant.id, leaseToken: null });
      return issued;
    }),
    fail: jest.fn(async (task: TelegramBotInboundTask, failureReason: string) => {
      const row = tasks.find((entry) => entry.id === task.id)!;
      await (quotaService.refund as jest.Mock)(row.telegramUserId, row.usageDate);
      Object.assign(row, { status: 'failed', failureReason, leaseToken: null });
    }),
    release: jest.fn(async (task: TelegramBotInboundTask) => {
      const row = tasks.find((entry) => entry.id === task.id)!;
      if (row.status === 'running') row.status = 'queued';
      row.leaseToken = null;
    }),
    retry: jest.fn(async (task: TelegramBotInboundTask, delay: number) => {
      const row = tasks.find((entry) => entry.id === task.id)!;
      Object.assign(row, { status: 'queued', leaseToken: null, availableAt: new Date(Date.now() + delay) });
    }),
    nextNotice: jest.fn(async (botId: string) => {
      const rows = tasks.filter((task) => task.receiverBotId === botId);
      const active = rows.filter((task) => task.status === 'queued' || task.status === 'running');
      for (const row of rows) {
        const position = row.status === 'queued' ? active.indexOf(row) + 1 : 0;
        if (row.status !== row.noticeStatus || position !== row.noticePosition) return { task: { ...row }, position };
      }
      return null;
    }),
    markNotice: jest.fn(async ({ task, position }: InboundNotice, messageId: number | null) => {
      const row = tasks.find((entry) => entry.id === task.id)!;
      Object.assign(row, { noticeStatus: task.status, noticePosition: position, waitingMsgId: messageId });
    }),
    deferNotice: jest.fn(async () => {}),
  };
  Object.assign(grantService, {
    findById: jest.fn(async (id: string) => queuedGrants.get(id)?.grant ?? null),
    tokenForQueuedNotice: jest.fn((grant: IssuedGrant['grant']) => queuedGrants.get(grant.id)?.token ?? null),
  });

  const service = new TelegramBotDispatchService(
    telegramService as never,
    botConfigService as never,
    quotaService as never,
    grantService as never,
    adminService as never,
    auditService as never,
    inboundQueue as unknown as TelegramBotInboundQueueService,
    pool as never,
    copies as never,
    (options.accountClient ?? null) as never,
    configService as never,
    null,
    mirrorConfig as never,
    attempts as never,
    (options.accountPoolDownload ?? null) as never,
    (options.storageRouter ?? null) as never,
    (options.downloadResources ?? null) as never,
    (options.uploadDiskBudget ?? null) as never,
    (options.transferTracker ?? null) as never,
  );

  if (options.botConfig?.storageMode === 'gdrive') {
    const runner = service as unknown as { pollQueue(): void; nextNoticeAt: Map<string, number> };
    jest.spyOn(runner.nextNoticeAt, 'get').mockReturnValue(undefined);
    queueTimers.push(setInterval(() => runner.pollQueue(), 10).unref());
  }

  return {
    service,
    inboundQueue,
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
    attempts,
    downloadResources: options.downloadResources ?? null,
    uploadDiskBudget: options.uploadDiskBudget ?? null,
    storageRouter: options.storageRouter ?? null,
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
      undefined,
    );
  });

  it('单账号模式：签发时记录默认 Token 的 botId 作为源账号', async () => {
    const ctx = makeService({ defaultBotToken: '9876543:BBBB' });

    await ctx.service.handleUpdate(makeMessageUpdate());

    expect(ctx.grantService.issue).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAccountId: '9876543' }),
      4,
      undefined,
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
      // 非中继目标群 → 只能标注 inbound（普通备份群消息不得伪装成中继生效）
      source: 'inbound',
    });
    // 命中站内文件 → 不计入「未命中」
    expect(pool.counters.inboundBridgeMisses).toBe(0);
    // 认领回写：fileUnique 与命中的 file 两个命名空间都要写，否则轮次里的认领对不上
    // 且必须带上消息所在群：多镜像群下同一文件有多条活跃轮次，不带目标群会串轮次
    expect(ctx.attempts!.recordClaim).toHaveBeenCalledWith('fileUnique', 'UNIQ-1', '1234567', {
      targetChatId: '-100777',
    });
    expect(ctx.attempts!.recordClaim).toHaveBeenCalledWith('file', 'file-1', '1234567', {
      targetChatId: '-100777',
    });
  });

  it('来自中继目标群的认领标注 relayed（副本扩散生效的唯一证据）', async () => {
    const pool = makePool(true);
    const bridge = jest.fn(async () => ({ bridged: true, matchedFileIds: ['file-1'] }));
    const copies = { upsertReady: jest.fn(async () => ({})), bridgeInboundCopyToLogicalFile: bridge };
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({
      pool,
      copies,
      accountClient,
      enabledMirrorTargetChatIds: ['-100777'],
    });

    await ctx.service.handleUpdate(
      makeMessageUpdate({ chatType: 'group', chatId: -100777 }),
      { accountId: '1234567' },
    );

    expect(bridge).toHaveBeenCalledWith(expect.objectContaining({ source: 'relayed' }));
    expect(copies.upsertReady).toHaveBeenCalledWith(expect.objectContaining({ source: 'relayed' }));
  });

  it('未启用规则的目标群消息不得标注 relayed（用未启用规则判定会污染观测数据）', async () => {
    const pool = makePool(true);
    const bridge = jest.fn(async () => ({ bridged: true, matchedFileIds: ['file-1'] }));
    const copies = { upsertReady: jest.fn(async () => ({})), bridgeInboundCopyToLogicalFile: bridge };
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({
      pool,
      copies,
      accountClient,
      // 抑制归档转发用的是「全部规则」，relayed 判定用的是「启用中的规则」——两者必须分开
      mirrorTargetChatIds: ['-100777'],
      enabledMirrorTargetChatIds: [],
    });

    await ctx.service.handleUpdate(
      makeMessageUpdate({ chatType: 'group', chatId: -100777 }),
      { accountId: '1234567' },
    );

    expect(bridge).toHaveBeenCalledWith(expect.objectContaining({ source: 'inbound' }));
    expect(copies.upsertReady).toHaveBeenCalledWith(expect.objectContaining({ source: 'inbound' }));
  });

  it('中继目标群但未命中站内文件：fileUnique 行仍为 inbound（只有真正产生副本才算 relayed）', async () => {
    const pool = makePool(true);
    const copies = {
      upsertReady: jest.fn(async () => ({})),
      bridgeInboundCopyToLogicalFile: jest.fn(async () => ({ bridged: false, matchedFileIds: [] })),
    };
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({
      pool,
      copies,
      accountClient,
      enabledMirrorTargetChatIds: ['-100777'],
    });

    await ctx.service.handleUpdate(
      makeMessageUpdate({ chatType: 'group', chatId: -100777 }),
      { accountId: '1234567' },
    );

    expect(copies.upsertReady).toHaveBeenCalledWith(expect.objectContaining({ source: 'inbound' }));
    // 未命中站内文件也要回写认领（fileUnique 行本身已产生副本），且同样带目标群
    expect(ctx.attempts!.recordClaim).toHaveBeenCalledWith('fileUnique', 'UNIQ-1', '1234567', {
      targetChatId: '-100777',
    });
  });

  it('轮次服务未装配时认领回写静默跳过（观测缺失不得影响入站主链路）', async () => {
    const pool = makePool(true);
    const copies = {
      upsertReady: jest.fn(async () => ({})),
      bridgeInboundCopyToLogicalFile: jest.fn(async () => ({ bridged: true, matchedFileIds: ['file-1'] })),
    };
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({ pool, copies, accountClient, attempts: null });

    await expect(ctx.service.handleUpdate(
      makeMessageUpdate({ chatType: 'group', chatId: -100777 }),
      { accountId: '1234567' },
    )).resolves.toBeUndefined();

    expect(copies.upsertReady).toHaveBeenCalled();
  });

  it('认领回写抛错不影响副本登记（观测故障不得回滚业务写入）', async () => {
    const pool = makePool(true);
    const copies = { upsertReady: jest.fn(async () => ({})) };
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({
      pool,
      copies,
      accountClient,
      attempts: { recordClaim: jest.fn(async () => { throw new Error('db down'); }) },
    });

    await ctx.service.handleUpdate(
      makeMessageUpdate({ chatType: 'group', chatId: -100777 }),
      { accountId: '1234567' },
    );

    expect(copies.upsertReady).toHaveBeenCalled();
    // 观测写入失败不得回滚业务写入，也不得污染「入站登记失败」计数
    expect(pool.counters.inboundRegistrationFailures).toBe(0);
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

  it('频道帖（channel_post）含 document：登记本账号副本，不回复、不扣配额、不签发直链', async () => {
    const pool = makePool(true);
    const copies = { upsertReady: jest.fn(async () => ({})) };
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({ pool, copies, accountClient });

    await ctx.service.handleUpdate(makeChannelPostUpdate(), { accountId: '1234567' });

    // 频道帖与群消息同等对待：只做非私聊副本登记（ownerType=fileUnique，file_id 来自该账号）
    expect(copies.upsertReady).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: 'fileUnique',
      ownerId: 'CH-UNIQ-1',
      accountId: '1234567',
      telegramFileId: 'CH-FILE-1',
    }));
    // 频道帖不是用户私聊：不回复消息、不扣配额、不签发直链
    expect(accountClient.sendMessage).not.toHaveBeenCalled();
    expect(ctx.telegramService.sendMessage).not.toHaveBeenCalled();
    expect(ctx.quotaService.consume).not.toHaveBeenCalled();
    expect(ctx.grantService.issue).not.toHaveBeenCalled();
  });

  it('频道帖（channel_post）无 document：无任何副作用', async () => {
    const pool = makePool(true);
    const copies = { upsertReady: jest.fn(async () => ({})) };
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({ pool, copies, accountClient });

    await ctx.service.handleUpdate(makeChannelPostUpdate({ document: null }), { accountId: '1234567' });

    expect(copies.upsertReady).not.toHaveBeenCalled();
    expect(accountClient.sendMessage).not.toHaveBeenCalled();
    expect(ctx.quotaService.consume).not.toHaveBeenCalled();
    expect(ctx.grantService.issue).not.toHaveBeenCalled();
  });

  it('私聊入站签发：issue 记录 fileUniqueId，并写入 grant 命名空间主副本行', async () => {
    const pool = makePool(true);
    const copies = { upsertReady: jest.fn(async () => ({})) };
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({ pool, copies, accountClient });

    await ctx.service.handleUpdate(makeMessageUpdate(), { accountId: '1234567' });

    // 内容标识落库到 grant：群内认领归因（findByFileUniqueId）的唯一键
    expect(ctx.grantService.issue).toHaveBeenCalledWith(
      expect.objectContaining({ fileUniqueId: 'UNIQ-1', sourceAccountId: '1234567' }),
      4,
      undefined,
    );
    // grant 命名空间主副本行：轮次结算的基线（source=inbound，账号为该消息的接收账号）
    expect(copies.upsertReady).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: 'grant',
      ownerId: 'grant-1',
      accountId: '1234567',
      telegramFileId: 'FILE-1',
      source: 'inbound',
    }));
  });

  it('群内认领命中 grant（中继目标群）：写 grant 副本（relayed）并回写 grant 认领', async () => {
    const pool = makePool(true);
    const bridge = jest.fn(async () => ({ bridged: true, matchedFileIds: ['file-1'] }));
    const copies = { upsertReady: jest.fn(async () => ({})), bridgeInboundCopyToLogicalFile: bridge };
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({
      pool,
      copies,
      accountClient,
      enabledMirrorTargetChatIds: ['-100777'],
      grantMatches: [{ id: 'grant-1' }],
    });

    await ctx.service.handleUpdate(
      makeMessageUpdate({ chatType: 'group', chatId: -100777 }),
      { accountId: '1234567' },
    );

    // 群内消息只带 file_unique_id → 必须用它反查 grant 才能归因
    expect(ctx.grantService.findByFileUniqueId).toHaveBeenCalledWith('UNIQ-1');
    expect(copies.upsertReady).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: 'grant',
      ownerId: 'grant-1',
      accountId: '1234567',
      telegramFileId: 'FILE-1',
      source: 'relayed',
    }));
    // 轮次结算按 grant:<id> 查 ready 副本 → 认领必须回写到 grant 命名空间
    expect(ctx.attempts!.recordClaim).toHaveBeenCalledWith('grant', 'grant-1', '1234567', {
      targetChatId: '-100777',
    });
  });

  it('非中继来源的群消息：不写 grant 命名空间副本、不写 grant 认领（只保留既有回写）', async () => {
    const pool = makePool(true);
    const bridge = jest.fn(async () => ({ bridged: true, matchedFileIds: ['file-1'] }));
    const copies = { upsertReady: jest.fn(async () => ({})), bridgeInboundCopyToLogicalFile: bridge };
    const accountClient = { sendMessage: jest.fn(async () => undefined), forwardMessage: jest.fn() };
    const ctx = makeService({
      pool,
      copies,
      accountClient,
      // 该群不是启用中的镜像规则目标群 → 普通备份群消息
      enabledMirrorTargetChatIds: [],
      grantMatches: [{ id: 'grant-1' }],
    });

    await ctx.service.handleUpdate(
      makeMessageUpdate({ chatType: 'group', chatId: -100777 }),
      { accountId: '1234567' },
    );

    // grant 归因整段不执行：普通群消息不得抬高 grant 命名空间的副本计数
    expect(ctx.grantService.findByFileUniqueId).not.toHaveBeenCalled();
    expect(copies.upsertReady).not.toHaveBeenCalledWith(expect.objectContaining({ ownerType: 'grant' }));
    expect(ctx.attempts!.recordClaim).not.toHaveBeenCalledWith(
      'grant',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    // 既有 fileUnique / file 两个命名空间的回写保持不动
    expect(ctx.attempts!.recordClaim).toHaveBeenCalledWith('fileUnique', 'UNIQ-1', '1234567', {
      targetChatId: '-100777',
    });
    expect(ctx.attempts!.recordClaim).toHaveBeenCalledWith('file', 'file-1', '1234567', {
      targetChatId: '-100777',
    });
  });
});

describe('TelegramBotDispatchService（纯 Google 存储模式）', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('私聊发送文件：先回复等待提示，后台转存 Google 云端硬盘并原地编辑为成功提示（不泄漏存储后端）', async () => {
    const pool = makePool(true);
    const accountClient = {
      sendMessage: jest.fn(async () => ({ messageId: 888 })),
      editMessageText: jest.fn(async () => true),
      forwardMessage: jest.fn(),
    };
    const storageRouter = {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      upload: jest.fn(async () => ({
        backendType: 'gdrive',
        accountId: 'gdrive-acc-1',
        objectRef: 'gdrive-file-id-123',
      })),
    };
    const ctx = makeService({
      pool,
      accountClient,
      storageRouter,
      botConfig: { storageMode: 'gdrive' },
    });

    await ctx.service.handleUpdate(makeMessageUpdate(), { accountId: '1234567' });

    await waitFor(() => accountClient.sendMessage.mock.calls.length > 0);
    // 1. 收件完成后通知排队位置
    expect(accountClient.sendMessage).toHaveBeenCalledWith(
      '1234567',
      '1234567:SECRET',
      '7001',
      expect.stringContaining('已加入队列，当前排第 1 位'),
      { replyToMessageId: 100 },
    );

    // 2. 等待后台转存完成
    await waitFor(() => storageRouter.upload.mock.calls.length > 0);

    expect(storageRouter.upload).toHaveBeenCalledWith(expect.objectContaining({
      backendType: 'gdrive',
      objectName: 'report.pdf',
      knownLength: 21,
      mimeType: 'application/pdf',
      openStream: expect.any(Function),
    }));

    // 3. 签发 grant，绑定 gdrive 存储后端
    await waitFor(() => ctx.grantService.issue.mock.calls.length > 0);
    expect(ctx.grantService.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        storageBackend: 'gdrive',
        storageAccountId: 'gdrive-acc-1',
        storageObjectRef: 'gdrive-file-id-123',
      }),
      4,
      undefined,
      expect.any(String),
    );

    // 4. 原地编辑消息为就绪提示，包含有效直链和自动删除提醒，且不展示存储后端
    await waitFor(() => ctx.inboundQueue.tasks.some((task) => task.noticeStatus === 'completed' || task.noticeStatus === 'failed'));
    expect(accountClient.editMessageText).toHaveBeenCalledWith(
      '1234567',
      '1234567:SECRET',
      '7001',
      888,
      expect.stringContaining('文件已就绪！'),
    );
    const finalContent = (accountClient.editMessageText.mock.calls as any).at(-1)[4] as string;
    expect(finalContent).toContain('下载直链（有效期至');
    expect(finalContent).toContain('https://files.example.com/api/bot-dl/TOKEN');
    expect(finalContent).toContain('⚠️ 链接到期后文件将自动失效并删除。');
    expect(finalContent).not.toMatch(/google|gdrive/i);
  });

  it('单账号模式下编辑消息失败时自动降级为回复新消息', async () => {
    const storageRouter = {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      upload: jest.fn(async () => ({
        backendType: 'gdrive',
        accountId: 'gdrive-acc-1',
        objectRef: 'gdrive-file-id-123',
      })),
    };
    const ctx = makeService({
      storageRouter,
      botConfig: { storageMode: 'gdrive' },
    });
    ctx.telegramService.sendMessage.mockResolvedValueOnce({ message_id: 666, chat: { id: 7001 } });
    (ctx.telegramService.editMessageText as jest.Mock).mockImplementation(
      async (_chat: string, _messageId: number, text: string) => !text.includes('文件已就绪！'),
    );

    await ctx.service.handleUpdate(makeMessageUpdate());

    await waitFor(() => storageRouter.upload.mock.calls.length > 0);
    await waitFor(() => ctx.inboundQueue.tasks[0].noticeStatus === 'completed');

    expect(ctx.telegramService.sendMessage).toHaveBeenLastCalledWith(
      '7001',
      expect.stringContaining('文件已就绪！'),
      { replyToMessageId: 100, deferRateLimit: true },
    );
  });

  it('转存失败时归还配额并提示失败（不泄漏敏感内部错误）', async () => {
    const pool = makePool(true);
    const accountClient = {
      sendMessage: jest.fn(async () => ({ messageId: 999 })),
      editMessageText: jest.fn(async () => true),
      forwardMessage: jest.fn(),
    };
    const storageRouter = {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      upload: jest.fn(async () => {
        throw new Error('GDrive upstream error 500');
      }),
    };
    const ctx = makeService({
      pool,
      accountClient,
      storageRouter,
      botConfig: { storageMode: 'gdrive' },
    });

    await ctx.service.handleUpdate(makeMessageUpdate(), { accountId: '1234567' });

    await waitFor(() => ctx.inboundQueue.tasks.some((task) => task.noticeStatus === 'completed' || task.noticeStatus === 'failed'));

    // 配额被归还
    expect(ctx.quotaService.refund).toHaveBeenCalledWith('7001', '2026-09-21');
    // 编辑消息为友好失败提示
    expect(accountClient.editMessageText).toHaveBeenCalledWith(
      '1234567',
      '1234567:SECRET',
      '7001',
      999,
      '创建下载链接失败，请稍后重试。',
    );
  });

  it('GDrive 转存中若上传成功但 issue 失败，应触发 Saga 补偿删除远端孤儿对象', async () => {
    const pool = makePool(true);
    const accountClient = {
      sendMessage: jest.fn(async () => ({ messageId: 999 })),
      forwardMessage: jest.fn(async () => ({ messageId: 1000 })),
      editMessageText: jest.fn(async () => true),
    };
    const storageRouter = {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      upload: jest.fn(async () => ({
        backendType: 'gdrive',
        accountId: 'gdrive-acc-saga',
        objectRef: 'gdrive-orphan-file-999',
      })),
      deleteRemoteObject: jest.fn(async () => true),
    };
    const ctx = makeService({
      pool,
      accountClient,
      storageRouter,
      botConfig: { storageMode: 'gdrive' },
    });
    ctx.grantService.issue.mockRejectedValueOnce(new Error('Database deadlock on grant issue'));

    await ctx.service.handleUpdate(makeMessageUpdate(), { accountId: '1234567' });

    await waitFor(() => ctx.service.getActiveTransferCount() === 0 && storageRouter.deleteRemoteObject.mock.calls.length > 0);

    // 验证：Saga 补偿已触发删除远端孤儿对象
    expect(storageRouter.deleteRemoteObject).toHaveBeenCalledWith(
      'gdrive',
      'gdrive-acc-saga',
      'gdrive-orphan-file-999',
    );
    // 配额被归还
    expect(ctx.quotaService.refund).toHaveBeenCalledWith('7001', '2026-09-21');
  });

  it('Finding 8: 转存前预约磁盘容量与严格上传预算，并在完成后或异常时释放', async () => {
    const pool = makePool(true);
    const accountClient = {
      sendMessage: jest.fn(async () => ({ messageId: 999 })),
      forwardMessage: jest.fn(),
      editMessageText: jest.fn(async () => true),
    };
    const storageRouter = {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      upload: jest.fn(async () => ({
        backendType: 'gdrive',
        accountId: 'gdrive-acc-1',
        objectRef: 'gdrive-file-id-123',
      })),
    };
    const mockReservation = {
      id: 'res-1',
      grantedBytes: 1024,
      remainingBytes: 1024,
      countsTowardCache: false,
      active: true,
      consume: jest.fn(),
      release: jest.fn(),
    };
    const downloadResources = {
      reserve: jest.fn(async () => mockReservation),
    };
    const uploadDiskBudget = {
      isStrictMode: jest.fn(() => true),
      acquireSession: jest.fn(async () => undefined),
      releaseSession: jest.fn(() => true),
    };

    const ctx = makeService({
      pool,
      accountClient,
      storageRouter,
      downloadResources,
      uploadDiskBudget,
      botConfig: { storageMode: 'gdrive' },
    });

    await ctx.service.handleUpdate(makeMessageUpdate(), { accountId: '1234567' });

    await waitFor(() => storageRouter.upload.mock.calls.length > 0);
    await waitFor(() => ctx.inboundQueue.tasks.some((task) => task.noticeStatus === 'completed' || task.noticeStatus === 'failed'));

    // 验证：严格上传模式会话已申请并在完成时释放
    expect(uploadDiskBudget.acquireSession).toHaveBeenCalledWith(expect.any(String), expect.any(Number));
    expect(uploadDiskBudget.releaseSession).toHaveBeenCalled();

    // 验证：磁盘容量已预约并在流式写入时核销、最终释放
    expect(downloadResources.reserve).toHaveBeenCalledWith(expect.objectContaining({
      countsTowardCache: false,
      waitTimeoutMs: 30_000,
    }));
    expect(mockReservation.consume).toHaveBeenCalled();
    expect(mockReservation.release).toHaveBeenCalled();
  });

  it('Finding 8: 磁盘容量不足时拒绝转存并友好提示用户、退还配额', async () => {
    const pool = makePool(true);
    const accountClient = {
      sendMessage: jest.fn(async () => ({ messageId: 999 })),
      forwardMessage: jest.fn(),
      editMessageText: jest.fn(async () => true),
    };
    const storageRouter = {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      upload: jest.fn(),
    };
    const downloadResources = {
      reserve: jest.fn(async () => {
        throw new Error('磁盘空间不足');
      }),
    };

    const ctx = makeService({
      pool,
      accountClient,
      storageRouter,
      downloadResources,
      botConfig: { storageMode: 'gdrive' },
    });

    await ctx.service.handleUpdate(makeMessageUpdate(), { accountId: '1234567' });

    await waitFor(() => ctx.inboundQueue.tasks.some((task) => task.noticeStatus === 'completed' || task.noticeStatus === 'failed'));

    // 验证：没有调用上传，提示友好错误，配额退还
    expect(storageRouter.upload).not.toHaveBeenCalled();
    expect(accountClient.editMessageText).toHaveBeenCalledWith(
      '1234567',
      '1234567:SECRET',
      '7001',
      999,
      '服务器临时磁盘空间不足，无法转存文件，请稍后重试。',
    );
    expect(ctx.quotaService.refund).toHaveBeenCalledWith('7001', '2026-09-21');
  });

  it('Finding 2: 池化账号拉流失败时 fail-closed，绝不降级回退至默认单账号', async () => {
    const pool = makePool(true);
    const accountClient = {
      sendMessage: jest.fn(async () => ({ messageId: 999 })),
      forwardMessage: jest.fn(),
      editMessageText: jest.fn(async () => true),
    };
    const storageRouter = {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      upload: jest.fn(),
    };
    const accountPoolDownload = {
      isActive: jest.fn(() => true),
      hasAccount: jest.fn(() => true),
      openSourceStream: jest.fn(async () => null), // 模拟拉流失败
    };

    const ctx = makeService({
      pool,
      accountClient,
      storageRouter,
      accountPoolDownload,
      botConfig: { storageMode: 'gdrive' },
    });

    await ctx.service.handleUpdate(makeMessageUpdate(), { accountId: '1234567' });

    await waitFor(() => ctx.inboundQueue.tasks.some((task) => task.noticeStatus === 'completed' || task.noticeStatus === 'failed'));

    // 验证：绝没有调用 telegramService.getRealtimeFileStream（单账号回源）
    expect(ctx.telegramService.getRealtimeFileStream).not.toHaveBeenCalled();
    expect(accountClient.editMessageText).toHaveBeenCalledWith(
      '1234567',
      '1234567:SECRET',
      '7001',
      999,
      '创建下载链接失败，请稍后重试。',
    );
    expect(ctx.quotaService.refund).toHaveBeenCalledWith('7001', '2026-09-21');
  });

  it('Finding 7: 前置条件异常或失败时释放消息锁，允许后续重试', async () => {
    const ctx = makeService({
      botConfig: { storageMode: 'gdrive' },
    });
    // 模拟域名解析抛出异常
    ctx.botConfigService.resolveSiteOriginAsync.mockRejectedValueOnce(new Error('DNS lookup failure'));

    await expect(ctx.service.handleUpdate(makeMessageUpdate())).rejects.toThrow('Bot 收件队列写入失败');

    // 再次发送同一消息：若前一次未释放锁，此处会回复“正在创建链接中”；若已释放，会正常进入流程
    ctx.botConfigService.resolveSiteOriginAsync.mockResolvedValueOnce('https://files.example.com');
    ctx.telegramService.sendMessage.mockClear();

    await ctx.service.handleUpdate(makeMessageUpdate());

    // 验证第二次没有被 msgKey 锁拦截为等待中
    const sentTexts = ctx.telegramService.sendMessage.mock.calls.map((call: any[]) => call[1]);
    expect(sentTexts).not.toContain('⏳ 该文件正在创建链接中，请稍候...');
  });

  it('转存期间注册临时文件租约并在转存完成后释放租约（防止被孤儿清理误删）', async () => {
    const pool = makePool(true);
    const accountClient = {
      sendMessage: jest.fn(async () => ({ messageId: 999 })),
      forwardMessage: jest.fn(),
      editMessageText: jest.fn(async () => true),
    };
    const storageRouter = {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      upload: jest.fn(async () => ({
        backendType: 'gdrive',
        accountId: 'gdrive-acc-1',
        objectRef: 'gdrive-file-id-123',
      })),
    };
    const releaseMock = jest.fn();
    const transferTracker = {
      register: jest.fn(() => releaseMock),
    };

    const ctx = makeService({
      pool,
      accountClient,
      storageRouter,
      transferTracker,
      botConfig: { storageMode: 'gdrive' },
    });

    await ctx.service.handleUpdate(makeMessageUpdate(), { accountId: '1234567' });

    await waitFor(() => storageRouter.upload.mock.calls.length > 0);
    await waitFor(() => ctx.inboundQueue.tasks.some((task) => task.noticeStatus === 'completed' || task.noticeStatus === 'failed'));

    // 验证：已注册临时文件租约并在完成后释放
    expect(transferTracker.register).toHaveBeenCalledWith(expect.stringMatching(/bot-transfers.*\.tmp$/));
    expect(releaseMock).toHaveBeenCalled();
  });

  it('Finding 12: 停机时等待后台转存排空（自然完成）', async () => {
    const pool = makePool(true);
    const accountClient = {
      sendMessage: jest.fn(async () => ({ messageId: 999 })),
      forwardMessage: jest.fn(),
      editMessageText: jest.fn(async () => true),
    };
    const storageRouter = {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      upload: jest.fn(async () => {
        await sleep(50);
        return {
          backendType: 'gdrive',
          accountId: 'gdrive-acc-1',
          objectRef: 'gdrive-file-id-123',
        };
      }),
    };

    const ctx = makeService({
      pool,
      accountClient,
      storageRouter,
      botConfig: { storageMode: 'gdrive' },
    });
    ctx.service.setShutdownDrainTimeoutMs(1000);

    // 触发转存
    await ctx.service.handleUpdate(makeMessageUpdate(), { accountId: '1234567' });
    await waitFor(() => ctx.service.getActiveTransferCount() === 1);

    // 触发停机排空
    await ctx.service.beforeApplicationShutdown();

    expect(ctx.service.getActiveTransferCount()).toBe(0);
    expect(ctx.inboundQueue.tasks[0].status).toBe('completed');
    expect(ctx.grantService.issue).toHaveBeenCalledTimes(1);
  });

  it('停机超时中止转存并保留队列和配额，供重启恢复', async () => {
    const pool = makePool(true);
    const accountClient = {
      sendMessage: jest.fn(async () => ({ messageId: 999 })),
      forwardMessage: jest.fn(),
      editMessageText: jest.fn(async () => true),
    };
    const storageRouter = {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      upload: jest.fn(async (params: any) => {
        // 模拟长耗时上传，直到 signal abort
        return new Promise((_resolve, reject) => {
          params.signal?.addEventListener('abort', () => {
            reject(new Error('上传已取消'));
          });
        });
      }),
    };

    const ctx = makeService({
      pool,
      accountClient,
      storageRouter,
      botConfig: { storageMode: 'gdrive' },
    });
    // 设置很短的超时以测试 abort
    ctx.service.setShutdownDrainTimeoutMs(50);

    await ctx.service.handleUpdate(makeMessageUpdate(), { accountId: '1234567' });
    await waitFor(() => ctx.service.getActiveTransferCount() === 1);

    // 触发停机
    await ctx.service.beforeApplicationShutdown();

    expect(ctx.service.getActiveTransferCount()).toBe(0);
    expect(ctx.quotaService.refund).not.toHaveBeenCalled();
    expect(ctx.inboundQueue.tasks[0]).toMatchObject({ status: 'queued', leaseToken: null });
  });

  it('Finding 12: 停机过程中到来的新消息被直接拒绝且不扣配额', async () => {
    const ctx = makeService({
      botConfig: { storageMode: 'gdrive' },
    });
    // 触发停机
    await ctx.service.beforeApplicationShutdown();

    ctx.telegramService.sendMessage.mockClear();
    await ctx.service.handleUpdate(makeMessageUpdate());

    // 验证：没有消耗配额，直接提示维护重启
    expect(ctx.quotaService.consume).not.toHaveBeenCalled();
    const sentTexts = ctx.telegramService.sendMessage.mock.calls.map((call: any[]) => call[1]);
    expect(sentTexts).toContain('服务正在维护重启中，请稍后重新发送文件。');
  });

  it('同一文件在途转存时收到重复更新（网络波动/重复投递），静默忽略而不重复发送等待提示', async () => {
    let completeUpload!: () => void;
    const uploadPromise = new Promise<{ backendType: 'gdrive'; accountId: string; objectRef: string }>((resolve) => {
      completeUpload = () => resolve({
        backendType: 'gdrive',
        accountId: 'gdrive-acc-1',
        objectRef: 'gdrive-file-id-123',
      });
    });

    const storageRouter = {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      upload: jest.fn(() => uploadPromise),
    };

    const ctx = makeService({
      storageRouter,
      botConfig: { storageMode: 'gdrive' },
    });

    // 第一次收到文件消息：进入转存并发送一次等待提示
    await ctx.service.handleUpdate(makeMessageUpdate({ messageId: 301 }));
    await waitFor(() => ctx.telegramService.sendMessage.mock.calls.length === 1);
    expect(ctx.telegramService.sendMessage).toHaveBeenCalledTimes(1);
    expect(ctx.telegramService.sendMessage).toHaveBeenCalledWith(
      '7001',
      expect.stringContaining('已加入队列，当前排第 1 位'),
      { replyToMessageId: 301, deferRateLimit: true },
    );

    // 同一消息因重试/长轮询重复到达：静默去重，绝不重复发送消息轰炸用户
    await ctx.service.handleUpdate(makeMessageUpdate({ messageId: 301 }));
    expect(ctx.telegramService.sendMessage).toHaveBeenCalledTimes(1);

    // 完成转存
    completeUpload();
    await waitFor(() => ctx.inboundQueue.tasks.some((task) => task.noticeStatus === 'completed'));
  });

  it('在途转存期间用户发送普通文本或提问，Bot 回复轻量提示且在冷却期内防刷静默，不倾倒 /help 帮助菜单', async () => {
    let completeUpload!: () => void;
    const uploadPromise = new Promise<{ backendType: 'gdrive'; accountId: string; objectRef: string }>((resolve) => {
      completeUpload = () => resolve({
        backendType: 'gdrive',
        accountId: 'gdrive-acc-1',
        objectRef: 'gdrive-file-id-123',
      });
    });

    const storageRouter = {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      upload: jest.fn(() => uploadPromise),
    };

    const ctx = makeService({
      storageRouter,
      botConfig: { storageMode: 'gdrive' },
    });

    // 触发转存
    await ctx.service.handleUpdate(makeMessageUpdate({ messageId: 401 }));
    await waitFor(() => ctx.service.getActiveTransferCount() === 1 && ctx.telegramService.sendMessage.mock.calls.length === 1);
    expect(ctx.telegramService.sendMessage).toHaveBeenCalledTimes(1);
    ctx.telegramService.sendMessage.mockClear();

    // 用户在等待期间提问："好了吗？"
    await ctx.service.handleUpdate(makeMessageUpdate({ messageId: 402, text: '好了吗？', document: null }));

    // 验证：回复轻量级等待提示，而非长篇幅的 /help 帮助菜单
    expect(ctx.telegramService.sendMessage).toHaveBeenCalledTimes(1);
    expect(ctx.telegramService.sendMessage).toHaveBeenCalledWith(
      '7001',
      '⏳ 您的文件正在创建直链中，请耐心等待完成通知，无需重复发送消息。',
      { replyToMessageId: 402 },
    );
    const firstCallText = (ctx.telegramService.sendMessage.mock.calls as any)[0][1];
    expect(firstCallText).not.toContain('/help');

    // 用户在冷却窗口内继续频繁发言："还要多久？"、"在吗"
    ctx.telegramService.sendMessage.mockClear();
    await ctx.service.handleUpdate(makeMessageUpdate({ messageId: 403, text: '还要多久？', document: null }));
    await ctx.service.handleUpdate(makeMessageUpdate({ messageId: 404, text: '在吗', document: null }));

    // 验证：在冷却期内被静默过滤，不再持续发消息轰炸用户
    expect(ctx.telegramService.sendMessage).not.toHaveBeenCalled();

    // 验证命令不受在途等待拦截影响（如 /quota）
    await ctx.service.handleUpdate(makeMessageUpdate({ messageId: 405, text: '/quota', document: null }));
    expect(ctx.telegramService.sendMessage).toHaveBeenCalledWith(
      '7001',
      expect.stringContaining('今日已使用'),
      { replyToMessageId: 405 },
    );

    // 完成转存
    completeUpload();
    await waitFor(() => ctx.inboundQueue.tasks.some((task) => task.noticeStatus === 'completed'));

    // 转存完成后，在途状态解除，后续普通文本恢复常规帮助提示
    ctx.telegramService.sendMessage.mockClear();
    await ctx.service.handleUpdate(makeMessageUpdate({ messageId: 406, text: '你好', document: null }));
    expect(ctx.telegramService.sendMessage).toHaveBeenCalledWith(
      '7001',
      expect.stringContaining('可用命令：'),
      { replyToMessageId: 406 },
    );
  });

  describe('Google 缓存模式异步镜像（triggerGDriveCacheMirror）', () => {
    it('attachGDriveCache 抛出异常时回滚删除远端 GDrive 对象（防孤儿泄漏）', async () => {
      const storageRouter = {
        availableBackendTypes: jest.fn(() => ['gdrive']),
        isGDriveCacheModeEnabled: jest.fn(async () => true),
        upload: jest.fn(async () => ({
          backendType: 'gdrive',
          accountId: 'acc-gd-1',
          objectRef: 'gdrive-mirror-file-123',
        })),
        deleteRemoteObject: jest.fn(async () => true),
      };
      const ctx = makeService({ storageRouter: storageRouter as any });
      ctx.grantService.attachGDriveCache = jest.fn(async () => {
        throw new Error('Database connection lost');
      });

      await (ctx.service as any).triggerGDriveCacheMirror(
        { id: 'grant-mirror-1' },
        { file_id: 'tg-file-123', file_name: 'test.mp4' },
        1024,
      );

      expect(storageRouter.upload).toHaveBeenCalled();
      expect(storageRouter.deleteRemoteObject).toHaveBeenCalledWith(
        'gdrive',
        'acc-gd-1',
        'gdrive-mirror-file-123',
      );
    });

    it('严格无缓存模式下先申请单生命周期租约并在完成后释放；租约被占时跳过镜像', async () => {
      const storageRouter = {
        availableBackendTypes: jest.fn(() => ['gdrive']),
        isGDriveCacheModeEnabled: jest.fn(async () => true),
        upload: jest.fn(async () => ({
          backendType: 'gdrive',
          accountId: 'acc-gd-1',
          objectRef: 'gdrive-mirror-file-456',
        })),
        deleteRemoteObject: jest.fn(async () => true),
      };
      const uploadDiskBudget = {
        isStrictMode: jest.fn(() => true),
        acquireSession: jest.fn(async () => undefined),
        releaseSession: jest.fn(),
      };
      const ctx = makeService({
        storageRouter: storageRouter as any,
        uploadDiskBudget: uploadDiskBudget as any,
      });

      await (ctx.service as any).triggerGDriveCacheMirror(
        { id: 'grant-mirror-2' },
        { file_id: 'tg-file-456', file_name: 'test.mp4' },
        2048,
      );

      expect(uploadDiskBudget.acquireSession).toHaveBeenCalledWith(expect.any(String), 2048);
      expect(uploadDiskBudget.releaseSession).toHaveBeenCalledWith(expect.any(String));

      // 模拟租约已被其他任务占有时跳过，不触发上传
      storageRouter.upload.mockClear();
      uploadDiskBudget.acquireSession = jest.fn(async () => {
        throw new Error('Upload session budget occupied');
      });

      await (ctx.service as any).triggerGDriveCacheMirror(
        { id: 'grant-mirror-3' },
        { file_id: 'tg-file-789', file_name: 'test.mp4' },
        2048,
      );

      expect(storageRouter.upload).not.toHaveBeenCalled();
    });
  });
});

function gate() {
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => { open = resolve; });
  return { open, waiting };
}

const botA = '1234567';
const botB = '7654321';

function pendingTransfers() {
  const uploads = new Map([[botA, gate()], [botB, gate()]]);
  const replies: { bot: string; id: number; kind: string }[] = [];
  const accountClient = {
    sendMessage: jest.fn(async (bot: string, _token: string, _chat: string, text: string, options: { replyToMessageId: number }) => {
      const kind = text.startsWith('请以「文件」方式发送') ? 'media-guidance'
        : text.includes('可用命令') ? 'help'
        : text.includes('无需重复发送消息') ? 'in-flight' : 'other';
      replies.push({ bot, id: options.replyToMessageId, kind });
      return { messageId: 99 };
    }),
    editMessageText: jest.fn(async () => true),
    forwardMessage: jest.fn(),
  };
  const { service } = makeService({
    pool: makePool(true),
    accountClient,
    accountPoolDownload: {
      isActive: jest.fn(() => true),
      hasAccount: jest.fn(() => true),
      openSourceStream: jest.fn(async () => ({ stream: Readable.from(['x']) })),
    },
    storageRouter: {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      upload: jest.fn(async (input: { objectName: string }) => {
        await uploads.get(input.objectName)!.waiting;
        return { backendType: 'gdrive', accountId: 'cloud', objectRef: input.objectName };
      }),
    },
    botConfig: { storageMode: 'gdrive' },
  });

  return {
    service, replies,
    start: (bot: string, messageId: number) => service.handleUpdate(makeMessageUpdate({
      messageId, document: { file_id: bot, file_unique_id: bot, file_name: bot, file_size: 1 },
    }), { accountId: bot }),
    ask: (bot: string, messageId: number) => service.handleUpdate(makeMessageUpdate({
      messageId, text: '进度如何？', document: null,
    }), { accountId: bot }),
    media: (kind: 'photo' | 'video', messageId: number) => {
      const update = makeMessageUpdate({ messageId, document: null });
      const file = { file_id: 'attachment', file_unique_id: 'unique', width: 1, height: 1 };
      Object.assign(update.message!, kind === 'photo' ? { photo: [file] } : { video: { ...file, duration: 1 } });
      return service.handleUpdate(update, { accountId: botA });
    },
    finish: (bot: string) => uploads.get(bot)!.open(),
    drain: async () => {
      for (const upload of uploads.values()) upload.open();
      await service.beforeApplicationShutdown();
    },
  };
}

describe('PR #63 等待提示', () => {
  it.each(['photo', 'video'] as const)('%s 在等待提示冷却期内仍应得到媒体格式指导', async (mediaType) => {
    const run = pendingTransfers();
    try {
      await run.start(botA, 10);
      run.replies.length = 0;
      await run.ask(botA, 11);
      await run.media(mediaType, 12);
      expect(run.replies).toEqual([
        { bot: botA, id: 11, kind: 'in-flight' },
        { bot: botA, id: 12, kind: 'media-guidance' },
      ]);
    } finally {
      await run.drain();
    }
  });

  it('尚无人发等待提示时，新的照片也应优先得到格式指导', async () => {
    const run = pendingTransfers();
    try {
      await run.start(botA, 20);
      run.replies.length = 0;
      await run.media('photo', 21);
      expect(run.replies).toEqual([{ bot: botA, id: 21, kind: 'media-guidance' }]);
    } finally {
      await run.drain();
    }
  });

  it('同一用户只有 A 在途时，B 的普通对话应照常显示帮助', async () => {
    const run = pendingTransfers();
    try {
      await run.start(botA, 30);
      run.replies.length = 0;
      await run.ask(botB, 31);
      expect(run.replies).toEqual([{ bot: botB, id: 31, kind: 'help' }]);
    } finally {
      await run.drain();
    }
  });

  it('A 与 B 都在途时，各自第一次发言和各自 15 秒边界互不占用', async () => {
    const run = pendingTransfers();
    const startTime = Date.now();
    let elapsed = 0;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => startTime + elapsed);
    try {
      await run.start(botA, 40);
      await run.start(botB, 41);
      run.replies.length = 0;
      await run.ask(botA, 42);
      elapsed = 6000;
      await run.ask(botB, 43);
      elapsed = 14999;
      await run.ask(botA, 44);
      elapsed = 15000;
      await run.ask(botB, 45);
      await run.ask(botA, 46);
      elapsed = 20999;
      await run.ask(botB, 47);
      elapsed = 21000;
      await run.ask(botB, 48);
      expect(run.replies).toEqual([
        { bot: botA, id: 42, kind: 'in-flight' },
        { bot: botB, id: 43, kind: 'in-flight' },
        { bot: botA, id: 46, kind: 'in-flight' },
        { bot: botB, id: 48, kind: 'in-flight' },
      ]);
    } finally {
      clock.mockRestore();
      await run.drain();
    }
  });

  it('A 完成后 A 恢复帮助，仍在转存中的 B 继续回复等待提示', async () => {
    const run = pendingTransfers();
    try {
      await run.start(botA, 50);
      await run.start(botB, 51);
      expect(run.service.getActiveTransferCount()).toBe(2);
      run.finish(botA);
      for (let i = 0; i < 250 && run.service.getActiveTransferCount() !== 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(run.service.getActiveTransferCount()).toBe(1);
      run.replies.length = 0;
      await run.ask(botA, 52);
      await run.ask(botB, 53);
      expect(run.replies).toEqual([
        { bot: botA, id: 52, kind: 'help' },
        { bot: botB, id: 53, kind: 'in-flight' },
      ]);
    } finally {
      await run.drain();
    }
  });
  it('同一用户给两个 Bot 发送不同文件，消息号相同也应签发两个正确授权', async () => {
    const uploads = gate();
    const accountClient = {
      sendMessage: jest.fn(async () => ({ messageId: 99 })),
      editMessageText: jest.fn(async () => true),
      forwardMessage: jest.fn(),
    };
    const ctx = makeService({
      pool: makePool(true),
      accountClient,
      accountPoolDownload: {
        isActive: jest.fn(() => true),
        hasAccount: jest.fn(() => true),
        openSourceStream: jest.fn(async () => ({ stream: Readable.from(['x']) })),
      },
      storageRouter: {
        availableBackendTypes: jest.fn(() => ['gdrive']),
        upload: jest.fn(async (input: { objectName: string }) => {
          await uploads.waiting;
          return { backendType: 'gdrive', accountId: 'cloud', objectRef: input.objectName };
        }),
      },
      botConfig: { storageMode: 'gdrive' },
    });
    const accounts = ['1234567', '7654321'];
    for (const id of accounts) {
      await ctx.service.handleUpdate(makeMessageUpdate({
        chatId: 7001, messageId: 123,
        document: { file_id: 'file-' + id, file_unique_id: 'unique-' + id, file_name: id, file_size: 1 },
      }), { accountId: id });
    }
    uploads.open();
    await waitFor(() => ctx.inboundQueue.tasks.every((task) => task.status === 'completed'));
    await ctx.service.beforeApplicationShutdown();
    expect((ctx.grantService.issue as jest.Mock).mock.calls.map(([grant]) => [grant.sourceAccountId, grant.telegramFileId]).sort())
      .toEqual(accounts.map((id) => [id, 'file-' + id]));
  });

  it('Telegram 通知暂未返回时文件仍可持久化和转存，重投不会重复签发', async () => {
    const waitingReply = gate();
    const router = {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      upload: jest.fn(async () => ({ backendType: 'gdrive', accountId: 'cloud', objectRef: 'test-object' })),
    };
    const ctx = makeService({ storageRouter: router, botConfig: { storageMode: 'gdrive' } });
    ctx.telegramService.sendMessage.mockImplementationOnce(async () => {
      await waitingReply.waiting;
      return { message_id: 99, chat: { id: 7001 } };
    });
    const update = makeMessageUpdate({ messageId: 555 });
    await ctx.service.handleUpdate(update);
    try {
      await waitFor(() => ctx.inboundQueue.tasks[0]?.status === 'completed');
      await ctx.service.handleUpdate(update);
      expect(ctx.grantService.issue).toHaveBeenCalledTimes(1);
      expect(ctx.inboundQueue.tasks).toHaveLength(1);
    } finally {
      waitingReply.open();
      await ctx.service.beforeApplicationShutdown();
    }
  });

});

describe('Bot 磁盘预算与停机补偿', () => {
  it.each(['gdrive', 'telegram'])('未知长度 %s 转存无法扩容时在落盘前失败并清理', async (storageMode) => {
    const releaseLease = jest.fn();
    const register = jest.fn((_file: string) => releaseLease);
    const reservation = { remainingBytes: 1, consume: jest.fn(), release: jest.fn() };
    const funds = {
      reserve: jest.fn(async () => reservation),
      extendDiskReservation: jest.fn(() => { throw new Error('磁盘额度耗尽'); }),
    };
    const router = {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      isGDriveCacheModeEnabled: jest.fn(async () => true),
      upload: jest.fn(),
    };
    const ctx = makeService({
      storageRouter: router, downloadResources: funds,
      transferTracker: { register }, botConfig: { storageMode },
    });
    await ctx.service.handleUpdate(makeMessageUpdate({
      document: { file_id: 'unknown-length', file_name: 'unknown' },
    }));
    await waitFor(() => funds.reserve.mock.calls.length > 0);
    await ctx.service.beforeApplicationShutdown();
    expect(funds.reserve).toHaveBeenCalledWith(expect.objectContaining({ bytes: 50 * 1024 * 1024 }));
    expect(funds.extendDiskReservation).toHaveBeenCalledWith(reservation, 20);
    expect(reservation.consume).not.toHaveBeenCalled();
    expect(router.upload).not.toHaveBeenCalled();
    expect(reservation.release).toHaveBeenCalledTimes(1);
    expect(releaseLease).toHaveBeenCalledTimes(1);
    expect(existsSync(register.mock.calls[0][0])).toBe(false);
    expect(ctx.quotaService.refund).toHaveBeenCalledTimes(storageMode === 'gdrive' ? 1 : 0);
  });

  it('正在转存的任务被取消后，不签发链接并清理已上传对象', async () => {
    const upload = gate();
    const router = {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      upload: jest.fn(async () => {
        await upload.waiting;
        return { backendType: 'gdrive', accountId: 'cloud', objectRef: 'cancelled-object' };
      }),
      deleteRemoteObject: jest.fn(async () => true),
    };
    const ctx = makeService({ storageRouter: router, botConfig: { storageMode: 'gdrive' } });
    await ctx.service.handleUpdate(makeMessageUpdate());
    try {
      await waitFor(() => router.upload.mock.calls.length === 1);
      ctx.inboundQueue.tasks[0].status = 'cancelled';
      upload.open();
      await waitFor(() => ctx.inboundQueue.tasks[0].noticeStatus === 'cancelled' && !ctx.inboundQueue.tasks[0].leaseToken);
      expect(ctx.grantService.issue).not.toHaveBeenCalled();
      expect(router.deleteRemoteObject).toHaveBeenCalledWith('gdrive', 'cloud', 'cancelled-object');
      expect(ctx.quotaService.refund).not.toHaveBeenCalled();
    } finally {
      upload.open();
      await ctx.service.beforeApplicationShutdown();
    }
  });

  it('同一 Bot 串行且尊重 Telegram 429，首个文件保持队首', async () => {
    const firstUpload = gate();
    const router = {
      availableBackendTypes: jest.fn(() => ['gdrive']),
      upload: jest.fn(async ({ objectName }: { objectName: string }) => {
        if (objectName === 'first') await firstUpload.waiting;
        return { backendType: 'gdrive', accountId: 'cloud', objectRef: objectName };
      }),
    };
    const ctx = makeService({ storageRouter: router, botConfig: { storageMode: 'gdrive' } });
    ctx.telegramService.getRealtimeFileStream.mockRejectedValueOnce(
      new TelegramAccountError('rate limited', botA, 'flood', 429, 1),
    );
    const file = (messageId: number, name: string) => makeMessageUpdate({
      messageId, document: { file_id: name, file_name: name, file_size: 21 },
    });
    await ctx.service.handleUpdate(file(100, 'first'));
    await ctx.service.handleUpdate(file(101, 'second'));
    try {
      await waitFor(() => ctx.inboundQueue.retry.mock.calls.length === 1);
      expect(ctx.inboundQueue.retry).toHaveBeenCalledWith(expect.objectContaining({ messageId: '100' }), 1_000);
      expect(router.upload).not.toHaveBeenCalled();
      await waitFor(() => router.upload.mock.calls.length === 1);
      expect(router.upload.mock.calls[0][0].objectName).toBe('first');
      expect(ctx.inboundQueue.tasks.map((task) => task.status)).toEqual(['running', 'queued']);
      await waitFor(() => ctx.inboundQueue.tasks[1].noticePosition === 2);
      expect(ctx.telegramService.sendMessage).toHaveBeenCalledWith(
        '7001', expect.stringContaining('当前排第 2 位'), { replyToMessageId: 101, deferRateLimit: true },
      );
      firstUpload.open();
      await waitFor(() => ctx.inboundQueue.tasks.every((task) => task.status === 'completed'));
      expect(router.upload.mock.calls.map(([input]) => input.objectName)).toEqual(['first', 'second']);
    } finally {
      firstUpload.open();
      await ctx.service.beforeApplicationShutdown();
    }
  });

});
