/**
 * 5b 回归：源锚点补齐（同一归属、当前版本）。
 *
 * 事故形态（本用例存在的理由）：
 * - `describeFile()` 只要主记录有 `fileId` 就直接返回，`chatId/messageId` 可能为空 →
 *   下游 `ensureAnchor` 只能以 `source_message_unresolved` 阻塞，而副本表里可能已有可信锚点；
 * - 异常回退必须先按当前 `file_unique_id` 查 `fileUnique` ready 副本；大小只作旧版本保护，
 *   同尺寸的其它唯一身份、缺身份、缺锚点或大小不匹配都不得回退；正常完整源描述符不查副本。
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
    telegramFileUniqueId: 'UNIQ-1',
    telegramFileId: 'tg-1',
    telegramChatId: '-100777',
    telegramMessageId: '55',
    telegramSourceAccountId: '777',
    ...overrides,
  };
}

function setup(options: {
  file?: Record<string, unknown> | null;
  readyByOwner?: Record<string, Array<Record<string, unknown>>>;
  poolAccountIds?: string[];
  poolSnapshotEnabledIds?: string[];
  poolEnabled?: boolean;
} = {}) {
  const filesRepo = { findOne: jest.fn(async () => options.file ?? null) };
  const grantsRepo = { findOne: jest.fn(async () => null) };
  const copies = {
    listReady: jest.fn(async (ownerType: string, ownerId: string) => (
      options.readyByOwner?.[`${ownerType}:${ownerId}`] ?? []
    )),
  };
  const pool = {
    isActive: jest.fn(() => options.poolEnabled ?? false),
    snapshot: jest.fn(() => ({
      enabled: options.poolEnabled ?? false,
      inactiveReason: options.poolEnabled ? null : 'disabled',
      counters: {
        selections: 0, failovers: 0, fallbacks: 0, unresolved: 0, streamFailures: 0, replyFailures: 0,
        inboundRegistrationFailures: 0, relayAttempts: 0, relaySucceeded: 0, relayFailed: 0,
        relayClaimsMissed: 0, inboundBridgeMisses: 0, anchorConflicts: 0, fallbackThrottled: 0,
        largeFileSlotThrottled: 0, mainChatPlantAttempts: 0, mainChatPlantFailures: 0, mainChatPlantTakeovers: 0,
      },
      accounts: (options.poolAccountIds ?? []).map((id) => ({
        id,
        enabled: (options.poolSnapshotEnabledIds ?? [id]).includes(id),
        storageConfigured: true,
      })),
    })),
  };
  const service = new TelegramMirrorSourceService(
    filesRepo as never,
    grantsRepo as never,
    copies as never,
    pool as never,
  );
  return { service, filesRepo, copies, pool };
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

  it('缺源锚点时跳过禁用副本，选择匹配身份且仍可执行的账号', async () => {
    const ctx = setup({
      file: makeFile({ telegramMessageId: null }),
      poolAccountIds: ['888', '999'],
      poolSnapshotEnabledIds: ['999'],
      poolEnabled: true,
      readyByOwner: {
        'fileUnique:UNIQ-1': [
          { accountId: '888', chatId: '-100888', messageId: '66', fileSize: '100', telegramFileId: 'tg-disabled' },
          { accountId: '999', chatId: '-100999', messageId: '77', fileSize: '100', telegramFileId: 'tg-enabled' },
        ],
      },
    });

    const descriptor = await ctx.service.describe('file', 'f-1');

    expect(ctx.copies.listReady).toHaveBeenCalledWith('fileUnique', 'UNIQ-1');
    expect(descriptor.chatId).toBe('-100999');
    expect(descriptor.messageId).toBe('77');
    expect(descriptor.sourceAccountId).toBe('999');
    expect(descriptor.fileId).toBe('tg-1');
    expect(descriptor.sourceVersion).toBe(1);
  });

  it('缺主 file_id 且池中没有可用的同身份副本时 fail-closed', async () => {
    const ctx = setup({
      file: makeFile({ telegramFileId: null, telegramChatId: null, telegramMessageId: null }),
      poolAccountIds: ['888'],
      poolSnapshotEnabledIds: [],
      poolEnabled: true,
      readyByOwner: {
        'fileUnique:UNIQ-1': [
          { accountId: '888', chatId: '-100888', messageId: '66', fileSize: '100', telegramFileId: 'tg-888' },
        ],
      },
    });

    await expect(ctx.service.describe('file', 'f-1')).rejects.toMatchObject({
      code: 'source_copy_identity_unresolved',
      kind: 'blocked',
    });
  });

  it('无池化模式下同身份副本可作为受控回退源', async () => {
    const ctx = setup({
      file: makeFile({ telegramFileId: null, telegramChatId: null, telegramMessageId: null }),
      poolEnabled: false,
      readyByOwner: {
        'fileUnique:UNIQ-1': [
          { accountId: '888', chatId: '-100888', messageId: '66', fileSize: '100', telegramFileId: 'tg-888' },
        ],
      },
    });

    const descriptor = await ctx.service.describe('file', 'f-1');

    expect(descriptor.chatId).toBe('-100888');
    expect(descriptor.messageId).toBe('66');
    expect(descriptor.sourceAccountId).toBe('888');
    expect(descriptor.fileId).toBe('tg-888');
  });

  it('同尺寸但 file_unique_id 不同的 ready 副本 → 不得用于 fileId 回退并 fail-closed', async () => {
    const ctx = setup({
      file: makeFile({ telegramFileId: null, telegramChatId: null, telegramMessageId: null }),
      readyByOwner: {
        'fileUnique:UNIQ-OTHER': [
          { accountId: '888', chatId: '-100888', messageId: '66', fileSize: '100', telegramFileId: 'tg-other' },
        ],
      },
    });

    await expect(ctx.service.describe('file', 'f-1')).rejects.toMatchObject({
      code: 'source_copy_identity_unresolved',
      kind: 'blocked',
    });

    expect(ctx.copies.listReady).toHaveBeenCalledTimes(1);
    expect(ctx.copies.listReady).toHaveBeenCalledWith('fileUnique', 'UNIQ-1');
  });

  it('缺 file_unique_id → 即使存在同尺寸 file 归属副本也不得回退，必须 blocked', async () => {
    const ctx = setup({
      file: makeFile({
        telegramFileUniqueId: null,
        telegramFileId: null,
        telegramChatId: null,
        telegramMessageId: null,
      }),
      readyByOwner: {
        'file:f-1': [
          { accountId: '888', chatId: '-100888', messageId: '66', fileSize: '100', telegramFileId: 'tg-unknown' },
        ],
      },
    });

    const result = ctx.service.describe('file', 'f-1');
    await expect(result).rejects.toMatchObject({
      code: 'source_copy_identity_unresolved',
      kind: 'blocked',
    });

    expect(ctx.copies.listReady).not.toHaveBeenCalled();
  });

  it('主记录缺锚点、匹配身份副本大小不一致 → 不补齐（fail-closed）', async () => {
    const ctx = setup({
      file: makeFile({ telegramChatId: null, telegramMessageId: null }),
      readyByOwner: {
        'fileUnique:UNIQ-1': [
          { accountId: '888', chatId: '-100888', messageId: '66', fileSize: '200', telegramFileId: 'tg-888' },
        ],
      },
    });

    const descriptor = await ctx.service.describe('file', 'f-1');

    expect(ctx.copies.listReady).toHaveBeenCalledWith('fileUnique', 'UNIQ-1');
    expect(descriptor.chatId).toBeNull();
    expect(descriptor.messageId).toBeNull();
    // 归属未被改动：不借用副本账号
    expect(descriptor.sourceAccountId).toBe('777');
  });

  it('同身份副本缺 chatId/messageId → 不可用，不补齐', async () => {
    const ctx = setup({
      file: makeFile({ telegramChatId: null, telegramMessageId: null }),
      readyByOwner: {
        'fileUnique:UNIQ-1': [
          { accountId: '888', chatId: null, messageId: '66', fileSize: '100', telegramFileId: 'tg-888' },
        ],
      },
    });

    const descriptor = await ctx.service.describe('file', 'f-1');

    expect(ctx.copies.listReady).toHaveBeenCalledWith('fileUnique', 'UNIQ-1');
    expect(descriptor.chatId).toBeNull();
    expect(descriptor.messageId).toBeNull();
    expect(descriptor.sourceAccountId).toBe('777');
  });

  it('主记录缺 fileId、同 file_unique_id 且同大小的 ready 副本 → 用匹配副本兜底，版本取主记录', async () => {
    const ctx = setup({
      file: makeFile({ telegramFileId: null, uploadVersion: 3 }),
      readyByOwner: {
        'fileUnique:UNIQ-1': [
          { accountId: '888', chatId: '-100888', messageId: '66', fileSize: '100', telegramFileId: 'tg-888' },
        ],
      },
    });

    const descriptor = await ctx.service.describe('file', 'f-1');

    expect(ctx.copies.listReady).toHaveBeenCalledWith('fileUnique', 'UNIQ-1');
    expect(descriptor.fileId).toBe('tg-888');
    expect(descriptor.chatId).toBe('-100888');
    expect(descriptor.sourceAccountId).toBe('888');
    // 副本行没有版本列：版本必须取主记录事实，否则幂等键会落在旧版本上
    expect(descriptor.sourceVersion).toBe(3);
  });

  it('主记录缺 fileId、匹配身份副本大小不符 → fail-closed，不沿用旧主锚点', async () => {
    const ctx = setup({
      file: makeFile({ telegramFileId: null }),
      readyByOwner: {
        'fileUnique:UNIQ-1': [
          { accountId: '888', chatId: '-100888', messageId: '66', fileSize: '200', telegramFileId: 'tg-stale' },
        ],
      },
    });

    await expect(ctx.service.describe('file', 'f-1')).rejects.toMatchObject({
      code: 'source_copy_identity_unresolved',
      kind: 'blocked',
    });

    expect(ctx.copies.listReady).toHaveBeenCalledWith('fileUnique', 'UNIQ-1');
  });
});
