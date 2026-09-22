import { Readable } from 'stream';
import { TelegramMirrorBotService } from './telegram-mirror-bot.service';
import { MirrorExecutionError } from './telegram-mirror.errors';

/**
 * Bot 镜像路径的安全边界回归。
 *
 * 重点不是「上传成功」这类顺利路径，而是**源账号锚定**：
 * - 有副本 → 走账号池（每个候选副本自带 file_id，天然不跨账号）；
 * - 无副本但能确认归属（锚定账号 = 默认 Bot）→ 允许默认链路；
 * - 无副本且归属不明 → 必须 fail-closed（blocked），绝不用默认账号去猜
 *   （用错账号的 file_id 会得到上游 502，或静默产出不可校验的备份）。
 */
describe('TelegramMirrorBotService（源账号锚定与回退安全）', () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const DEFAULT_BOT_ID = '111111';

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = `${DEFAULT_BOT_ID}:AA-default`;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  });

  function setup(options: {
    copies?: Array<Record<string, unknown>>;
    poolActive?: boolean;
    anchoredAccountId?: string | null;
    fileSize?: number;
    upstreamSize?: number;
    /** 池内「已配置存储 Chat」的账号（上传/镜像候选） */
    storageAccountIds?: string[];
    /** 池内**全部**注册账号（用于复刻 `select` 的「空数组 = 全池」语义） */
    poolAccountIds?: string[];
    /** 面板（数据库）账号；传空数组可模拟「池内无候选」 */
    panelAccounts?: Array<Record<string, unknown>>;
  } = {}) {
    const stream = Readable.from(Buffer.from('x'.repeat(64)));
    const source = {
      describe: jest.fn(async () => ({
        fileId: 'PRIMARY-FILE-ID',
        fileSize: options.fileSize ?? 64,
        fileName: 'doc.bin',
        chatId: '-100111',
        messageId: '7',
        sourceAccountId: options.anchoredAccountId ?? null,
      })),
    };
    const telegram = {
      getRealtimeFileStream: jest.fn(async () => ({
        stream,
        info: { file_id: 'PRIMARY-FILE-ID', file_path: '', file_size: options.upstreamSize ?? 64 },
      })),
      uploadFile: jest.fn(async () => ({
        file_id: 'DEFAULT-UP',
        file_path: '',
        file_size: 64,
        message_id: '11',
        chat_id: '-100222',
        file_unique_id: 'u1',
      })),
    };
    const counters: Record<string, number> = {};
    const pool = {
      isActive: () => options.poolActive ?? false,
      inactiveReason: () => null,
      getConfig: (id: string) => (id
        ? {
          id,
          // 与面板账号保持一致，便于断言「池化选号后仍用该账号的 Token」
          token: id === '222222' ? '222222:BB-panel' : `${id}:TOKEN`,
          chatId: '-1',
          enabled: true,
          weight: 1,
          maxInflight: 8,
          source: 'env' as const,
        }
        : null),
      storageAccountIds: () => options.storageAccountIds ?? ['222222'],
      // 与真实实现保持一致：**空数组**表示「不限定候选 = 全池」，而不是「无候选」。
      // 若桩写成「空数组返回 null」，会掩盖「把空数组传进 select」这类缺陷。
      select: jest.fn((candidateIds?: string[]) => {
        const all = options.poolAccountIds ?? ['222222'];
        const ids = candidateIds && candidateIds.length > 0 ? candidateIds : all;
        return ids.length > 0 ? { accountId: ids[0], score: 1, reason: 'stub' } : null;
      }),
      beginAttempt: jest.fn(() => true),
      finishAttempt: jest.fn(),
      bumpCounter: jest.fn((key: string, delta = 1) => {
        counters[key] = (counters[key] ?? 0) + delta;
      }),
      counters,
    };
    const client = {
      sendDocumentStream: jest.fn(async () => ({
        fileId: 'PANEL-UP',
        fileSize: 64,
        chatId: '-100222',
        messageId: '22',
        fileUniqueId: 'uniq-panel',
        sample: { ok: true, bytes: 64, durationMs: 10 },
      })),
    };
    const downloader = {
      isActive: () => true,
      openStream: jest.fn(async () => (
        options.copies && options.copies.length > 0
          ? { stream, info: { file_id: 'COPY-FILE-ID', file_path: '', file_size: 64 }, accountId: 'panel-copy' }
          : null
      )),
      openSourceStream: jest.fn(async () => null),
    };
    const copies = {
      listReady: jest.fn(async () => options.copies ?? []),
      upsertReady: jest.fn(async () => undefined),
    };
    const accounts = {
      resolveEnabledBotAccounts: jest.fn(async () => (options.panelAccounts ?? [
        { id: 'row-1', accountId: '222222', token: '222222:BB-panel', chatId: '-1', weight: 1, maxInflight: 4 },
      ])),
      markDegraded: jest.fn(async () => undefined),
    };

    const service = new TelegramMirrorBotService(
      source as never,
      telegram as never,
      pool as never,
      client as never,
      downloader as never,
      copies as never,
      accounts as never,
    );
    return { service, source, telegram, pool, client, downloader, copies, accounts, stream };
  }

  const task = { id: 'task-1', ownerType: 'file', ownerId: 'file-1', sourceAccountId: null, mode: 'bot_upload' } as never;
  const rule = { id: 'rule-1', targetChatId: '-100222', preferredAccountId: null } as never;

  it('存在可用副本时走账号池取源，并由目标账号二次上传到备份群', async () => {
    const harness = setup({
      copies: [{ telegramFileId: 'COPY-FILE-ID', accountId: 'panel-copy', chatId: '-100111', messageId: '7' }],
      poolActive: true,
    });

    const result = await harness.service.execute(task, rule);

    expect(harness.downloader.openStream).toHaveBeenCalledTimes(1);
    expect(harness.client.sendDocumentStream).toHaveBeenCalledWith(
      '222222',
      '222222:BB-panel',
      '-100222',
      expect.anything(),
      'doc.bin',
      64,
    );
    expect(result).toMatchObject({
      targetAccountId: '222222',
      targetChatId: '-100222',
      targetMessageId: '22',
      targetTelegramFileId: 'PANEL-UP',
      mode: 'bot_upload',
    });
    // 备份副本必须按「目标账号自己的 file_id」登记
    expect(harness.copies.upsertReady).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: 'file',
      ownerId: 'file-1',
      accountId: '222222',
      telegramFileId: 'PANEL-UP',
    }));
    // 账号级上传必须计入池内运行态（在飞 + 采样），否则镜像会绕过容量与冷却控制
    expect(harness.pool.beginAttempt).toHaveBeenCalledWith('222222');
    expect(harness.pool.finishAttempt).toHaveBeenCalledWith('222222', expect.objectContaining({ ok: true }));
  });

  it('池化模式：目标账号改由账号池统一选号（复用 storageAccountIds 与 select）', async () => {
    const harness = setup({
      copies: [{ telegramFileId: 'COPY-FILE-ID', accountId: 'panel-copy', chatId: '-100111', messageId: '7' }],
      poolActive: true,
      storageAccountIds: ['222222', '333333'],
    });

    const result = await harness.service.execute(task, rule);

    expect(harness.pool.select).toHaveBeenCalledWith(['222222', '333333']);
    expect(result).toMatchObject({ targetAccountId: '222222' });
    expect(harness.client.sendDocumentStream).toHaveBeenCalledWith(
      '222222',
      '222222:BB-panel',
      '-100222',
      expect.anything(),
      'doc.bin',
      64,
    );
  });

  it('池已启用但无任何可用候选：回落默认 Bot 并累计 fallbacks', async () => {
    const harness = setup({
      copies: [{ telegramFileId: 'COPY-FILE-ID', accountId: 'panel-copy', chatId: '-100111', messageId: '7' }],
      poolActive: true,
      storageAccountIds: [],
      panelAccounts: [],
    });

    const result = await harness.service.execute(task, rule);

    expect(result).toMatchObject({ targetAccountId: DEFAULT_BOT_ID });
    expect(harness.telegram.uploadFile).toHaveBeenCalled();
    expect(harness.pool.counters.fallbacks).toBe(1);
  });

  it('池内无「已配置存储 Chat」的账号：不得调用选号（空数组 = 全池哨兵），直接回落默认 Bot', async () => {
    const harness = setup({
      copies: [{ telegramFileId: 'COPY-FILE-ID', accountId: 'panel-copy', chatId: '-100111', messageId: '7' }],
      poolActive: true,
      // 池内确实有账号，但没有一个配置了存储 Chat
      storageAccountIds: [],
      poolAccountIds: ['no-chat-account'],
    });

    const result = await harness.service.execute(task, rule);

    // 关键回归点：把空数组传进 select 会被解释为「全池」，从而选中 no-chat-account
    expect(harness.pool.select).not.toHaveBeenCalled();
    expect(result).toMatchObject({ targetAccountId: DEFAULT_BOT_ID });
    expect(harness.pool.counters.fallbacks).toBe(1);
  });

  it('池化模式下既无副本、也无法确认归属时：fail-closed，绝不用默认账号猜', async () => {
    const harness = setup({ copies: [], poolActive: true, anchoredAccountId: null });

    await expect(harness.service.execute(task, rule)).rejects.toMatchObject({
      code: 'source_account_unresolved',
      kind: 'blocked',
    });
    expect(harness.telegram.uploadFile).not.toHaveBeenCalled();
    expect(harness.client.sendDocumentStream).not.toHaveBeenCalled();
  });

  it('池化模式 + 归属确认为默认 Bot：允许默认链路取源（Web 上传文件不再全量 blocked）', async () => {
    const harness = setup({ copies: [], poolActive: true, anchoredAccountId: DEFAULT_BOT_ID });

    const result = await harness.service.execute(task, rule);

    // 取源侧：默认 Bot 的 file_id 由默认链路取得（归属可确认，不再 fail-closed）
    expect(harness.telegram.getRealtimeFileStream).toHaveBeenCalledWith('PRIMARY-FILE-ID', 64);
    // 上传侧：仍由目标账号二次上传到备份群（与取源侧解耦）
    expect(harness.client.sendDocumentStream).toHaveBeenCalledWith(
      '222222',
      '222222:BB-panel',
      '-100222',
      expect.anything(),
      'doc.bin',
      64,
    );
    expect(result).toMatchObject({
      targetAccountId: '222222',
      targetChatId: '-100222',
      targetMessageId: '22',
      targetTelegramFileId: 'PANEL-UP',
    });
  });

  it('无法确定源文件大小时：拒绝上传并释放流（避免产生不可校验的备份）', async () => {
    const harness = setup({ copies: [], poolActive: false, fileSize: 0, upstreamSize: 0 });

    await expect(harness.service.execute(task, rule)).rejects.toBeInstanceOf(MirrorExecutionError);
    await expect(harness.service.execute(task, rule)).rejects.toMatchObject({ code: 'source_size_unknown' });
    expect(harness.client.sendDocumentStream).not.toHaveBeenCalled();
  });
});
