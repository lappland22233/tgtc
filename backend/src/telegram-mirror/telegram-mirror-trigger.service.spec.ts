import { TelegramMirrorTriggerService } from './telegram-mirror-trigger.service';

describe('TelegramMirrorTriggerService Bot 入站扩散', () => {
  function setup(options: {
    includeBotInboundFiles?: boolean;
    sourceChatId?: string;
    targetChatId?: string;
    existingTaskStatus?: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'queued';
  } = {}) {
    const tasks = {
      enqueue: jest.fn(async () => ({ created: true, task: { id: 'task-1' } })),
      findLatestForOwner: jest.fn(async () => options.existingTaskStatus
        ? { id: 'task-existing', status: options.existingTaskStatus }
        : null),
      requeueTerminal: jest.fn(async () => true),
    };
    const config = {
      listEnabledRules: jest.fn(async () => [{
        id: 'rule-1',
        enabled: true,
        includeWebUploads: true,
        includeBotInboundFiles: options.includeBotInboundFiles ?? true,
        sourceChatId: options.sourceChatId ?? '-100source',
        targetChatId: options.targetChatId ?? '-100target',
      }]),
    };
    const feature = { isMirrorEnabled: jest.fn(async () => true) };
    const metrics = { bump: jest.fn() };
    const source = { describe: jest.fn(async () => ({
      fileId: 'tg-file-id',
      fileSize: 4 * 1024 ** 3,
      fileName: 'test.bin',
      chatId: '7001',
      messageId: '100',
      sourceAccountId: '8220426368',
      sourceVersion: 1,
    })) };
    const service = new TelegramMirrorTriggerService(
      tasks as never,
      config as never,
      feature as never,
      metrics as never,
      source as never,
    );
    return { service, tasks, config, feature, metrics, source };
  }

  const input = {
    ownerType: 'grant' as const,
    ownerId: 'grant-1',
    sourceVersion: 1,
    sourceAccountId: '8220426368',
    sourceChatId: '7001',
    sourceMessageId: '100',
  };

  it('Bot 入站范围开启时按 grant 锚点创建镜像任务', async () => {
    const ctx = setup({ includeBotInboundFiles: true });

    await expect(ctx.service.onFileCommitted(input, 'bot_inbound')).resolves.toBe(true);

    expect(ctx.tasks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      ruleId: 'rule-1',
      ownerType: 'grant',
      ownerId: 'grant-1',
      sourceAccountId: '8220426368',
      sourceChatId: '7001',
      sourceMessageId: '100',
    }));
    expect(ctx.metrics.bump).toHaveBeenCalledWith('tasksQueued');
  });

  it('管理员显式关闭 Bot 入站范围时不创建任务', async () => {
    const ctx = setup({ includeBotInboundFiles: false });

    await expect(ctx.service.onFileCommitted(input, 'bot_inbound')).resolves.toBe(false);
    expect(ctx.tasks.enqueue).not.toHaveBeenCalled();
  });

  it('管理员为已有 grant 补触发：只给已允许 Bot 入站的规则建单', async () => {
    const ctx = setup({ includeBotInboundFiles: true });
    const result = await ctx.service.retryForOwner({ ownerType: 'grant', ownerId: 'grant-1', operatorUserId: 'admin-1' });

    expect(result).toMatchObject({ created: 1, requeued: 0, ruleIds: ['rule-1'] });
    expect(ctx.source.describe).toHaveBeenCalledWith('grant', 'grant-1');
    expect(ctx.tasks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ ownerType: 'grant', ownerId: 'grant-1' }));
  });

  it('grant 已经成功扩散时重试只报告跳过，不清回执、不重复转发', async () => {
    const ctx = setup({ includeBotInboundFiles: true, existingTaskStatus: 'succeeded' });
    const result = await ctx.service.retryForOwner({ ownerType: 'grant', ownerId: 'grant-1', operatorUserId: 'admin-1' });

    expect(result).toMatchObject({ created: 0, requeued: 0, skippedSucceeded: 1 });
    expect(ctx.tasks.requeueTerminal).not.toHaveBeenCalled();
    expect(ctx.tasks.enqueue).not.toHaveBeenCalled();
    expect(ctx.source.describe).not.toHaveBeenCalled();
  });

  it('管理员重试 grant 时尊重显式关闭的 Bot 入站规则', async () => {
    const ctx = setup({ includeBotInboundFiles: false });

    await expect(ctx.service.retryForOwner({ ownerType: 'grant', ownerId: 'grant-1', operatorUserId: 'admin-1' }))
      .rejects.toThrow('没有启用中的镜像规则，无法重试扩散');
    expect(ctx.tasks.enqueue).not.toHaveBeenCalled();
  });

  it('来源就是目标镜像群时仍跳过，避免扩散回环', async () => {
    const ctx = setup({ sourceChatId: '-100target', targetChatId: '-100target' });

    await expect(ctx.service.onFileCommitted({ ...input, sourceChatId: '-100target' }, 'bot_inbound')).resolves.toBe(false);
    expect(ctx.tasks.enqueue).not.toHaveBeenCalled();
  });
});
