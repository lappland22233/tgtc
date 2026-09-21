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
    const pool = {
      isActive: () => options.poolActive ?? false,
      getConfig: (id: string) => (id ? { id } : null),
    };
    const client = {
      sendDocumentStream: jest.fn(async () => ({
        fileId: 'PANEL-UP',
        fileSize: 64,
        chatId: '-100222',
        messageId: '22',
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
      resolveEnabledBotAccounts: jest.fn(async () => [
        { id: 'row-1', accountId: '222222', token: '222222:BB-panel', chatId: '-1', weight: 1, maxInflight: 4 },
      ]),
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
