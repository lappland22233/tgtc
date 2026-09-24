/**
 * 5b 回归：源锚点补齐（同一归属、当前版本）。
 *
 * 事故形态（本用例存在的理由）：
 * - `describeFile()` 只要主记录有 `fileId` 就直接返回，`chatId/messageId` 可能为空 →
 *   下游 `ensureAnchor` 只能以 `source_message_unresolved` 阻塞，而副本表里可能已有可信锚点；
 * - 补齐必须遵守「同归属 + 当前版本」：副本大小与文件大小都已知且不一致时宁可阻塞，
 *   也不从中继旧内容；副本缺 chat/message 的行不可用；没有可用副本时保持原描述符。
 */
import 'reflect-metadata';
import { TelegramMirrorSourceService, isUsableSourceCopyAnchor } from './telegram-mirror-source.service';

function makeFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'f-1',
    originalName: 'a.bin',
    filename: 'a.bin',
    size: 100,
    uploadVersion: 1,
    telegramFileId: 'tg-1',
    telegramChatId: '-100777',
    telegramMessageId: '55',
    telegramSourceAccountId: '777',
    ...overrides,
  };
}

function setup(options: {
  file?: Record<string, unknown> | null;
  ready?: Array<Record<string, unknown>>;
} = {}) {
  const filesRepo = { findOne: jest.fn(async () => options.file ?? null) };
  const grantsRepo = { findOne: jest.fn(async () => null) };
  const copies = { listReady: jest.fn(async () => options.ready ?? []) };
  const service = new TelegramMirrorSourceService(
    filesRepo as never,
    grantsRepo as never,
    copies as never,
  );
  return { service, filesRepo, copies };
}

describe('isUsableSourceCopyAnchor（锚点可用性纯函数口径）', () => {
  const base = { chatId: '-100', messageId: '1', fileSize: null as string | null };

  it('chatId/messageId 缺一不可', () => {
    expect(isUsableSourceCopyAnchor(100, { ...base, fileSize: '100', chatId: '' })).toBe(false);
    expect(isUsableSourceCopyAnchor(100, { ...base, fileSize: '100', messageId: '   ' })).toBe(false);
    expect(isUsableSourceCopyAnchor(100, { ...base, fileSize: '100' })).toBe(true);
  });

  it('大小至少一方未知时视为可用；双方都已知时必须一致', () => {
    // 副本大小未知
    expect(isUsableSourceCopyAnchor(100, { ...base })).toBe(true);
    // 文件大小未知
    expect(isUsableSourceCopyAnchor(null, { ...base, fileSize: '100' })).toBe(true);
    expect(isUsableSourceCopyAnchor(100, { ...base, fileSize: '100' })).toBe(true);
    expect(isUsableSourceCopyAnchor(100, { ...base, fileSize: '200' })).toBe(false);
  });
});

describe('TelegramMirrorSourceService.describeFile（源锚点补齐）', () => {
  it('主记录锚点完整 → 原样返回（不查副本表）', async () => {
    const ctx = setup({ file: makeFile() });

    const descriptor = await ctx.service.describe('file', 'f-1');

    expect(descriptor).toEqual({
      fileId: 'tg-1',
      fileSize: 100,
      fileName: 'a.bin',
      chatId: '-100777',
      messageId: '55',
      sourceAccountId: '777',
      sourceVersion: 1,
    });
    expect(ctx.copies.listReady).not.toHaveBeenCalled();
  });

  it('主记录缺 messageId、存在同大小 ready 副本 → 用副本锚点与副本账号补齐', async () => {
    const ctx = setup({
      file: makeFile({ telegramMessageId: null }),
      ready: [{ accountId: '888', chatId: '-100888', messageId: '66', fileSize: '100' }],
    });

    const descriptor = await ctx.service.describe('file', 'f-1');

    expect(ctx.copies.listReady).toHaveBeenCalledWith('file', 'f-1');
    expect(descriptor.chatId).toBe('-100888');
    expect(descriptor.messageId).toBe('66');
    // 搬运只能由持有该消息的账号执行：来源账号随锚点一起取副本账号
    expect(descriptor.sourceAccountId).toBe('888');
    // 其它字段保持主记录事实
    expect(descriptor.fileId).toBe('tg-1');
    expect(descriptor.sourceVersion).toBe(1);
  });

  it('主记录缺锚点、副本大小与文件大小不一致 → 不补齐（返回原描述符，锚点仍为空）', async () => {
    const ctx = setup({
      file: makeFile({ telegramChatId: null, telegramMessageId: null }),
      ready: [{ accountId: '888', chatId: '-100888', messageId: '66', fileSize: '200' }],
    });

    const descriptor = await ctx.service.describe('file', 'f-1');

    expect(descriptor.chatId).toBeNull();
    expect(descriptor.messageId).toBeNull();
    // 归属未被改动：不借用副本账号
    expect(descriptor.sourceAccountId).toBe('777');
  });

  it('副本 chatId/messageId 为空 → 不可用，不补齐', async () => {
    const ctx = setup({
      file: makeFile({ telegramChatId: null, telegramMessageId: null }),
      ready: [{ accountId: '888', chatId: null, messageId: '66', fileSize: '100' }],
    });

    const descriptor = await ctx.service.describe('file', 'f-1');

    expect(descriptor.chatId).toBeNull();
    expect(descriptor.messageId).toBeNull();
  });
});
