/**
 * 5a 回归：Web 回源归属 fail-closed。
 *
 * 事故形态（本用例存在的理由）：
 * - `openTelegramSourceStream` 在「池化取流失败 + 源账号兜底失败」后曾**无条件**落入
 *   默认 Bot 回源；当 `telegramSourceAccountId` 是非默认 Bot 的池内账号时，它的
 *   `file_id` 只对该账号有效，用默认 Bot 去取会得到上游错误/无效引用（跨账号误用）。
 * - 修复后与 Bot 直链路径的安全矩阵对齐：归属不可确认 → 拒绝跨账号回退
 *   （503 DOWNLOAD_SERVER_BUSY + unresolved 计数），其余情况（来源为空 / 来源即默认
 *   Bot）保持既有默认链路。
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Readable } from 'stream';
import { FileService } from './file.service';
import { DownloadResourceException } from './download-resource-coordinator.service';

const DEFAULT_BOT_TOKEN = '123456:TEST-TOKEN';
/** 默认 Bot 的账号 id = token 前缀（`defaultBotAccountId()` 的口径） */
const DEFAULT_ACCOUNT_ID = '123456';

function makeStream(): Readable {
  return Readable.from([Buffer.from('x')]);
}

function makeFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'f-1',
    originalName: 'a.bin',
    filename: 'a.bin',
    telegramFileId: 'tg-1',
    telegramSourceAccountId: null,
    size: 1024,
    ...overrides,
  };
}

/**
 * 以最小桩直接构造 `FileService`（与 file.service.prewarm.spec.ts / overwrite.spec.ts 同法）：
 * 只有 telegramService / configService 与可选依赖（accountAwareDownload / fileCopies）被触达。
 */
function setup(options: {
  copies?: Array<Record<string, unknown>>;
  openStreamResult?: Record<string, unknown> | null;
  openSourceStreamResult?: Record<string, unknown> | null;
} = {}) {
  const getRealtimeFileStream = jest.fn(async () => ({
    stream: makeStream(),
    info: { file_id: 'legacy-file-id', file_path: 'legacy/path', file_size: 1024 },
  }));
  const openStream = jest.fn(async () => options.openStreamResult ?? null);
  const openSourceStream = jest.fn(async () => options.openSourceStreamResult ?? null);
  const bumpCounter = jest.fn();
  const accountAwareDownload = {
    isActive: () => true,
    openStream,
    openSourceStream,
    bumpCounter,
  };
  const fileCopies = {
    listReady: jest.fn(async () => options.copies ?? []),
  };
  const configService = {
    get: jest.fn((key: string) => (key === 'TELEGRAM_BOT_TOKEN' ? DEFAULT_BOT_TOKEN : undefined)),
  };

  const service = new FileService(
    {} as never,                        // 1  fileRepository
    {} as never,                        // 2  folderRepository
    {} as never,                        // 3  accessLogRepository
    {} as never,                        // 4  shareAuditRepository
    {} as never,                        // 5  shareLinkRepository
    { getRealtimeFileStream } as never, // 6  telegramService
    configService as never,             // 7  configService
    {} as never,                        // 8  jwtService
    {} as never,                        // 9  configCacheService
    {} as never,                        // 10 uploadJobService
    {} as never,                        // 11 auditService
    {} as never,                        // 12 fileCacheService
    {} as never,                        // 13 thumbnailService
    {} as never,                        // 14 namespaceService
    {} as never,                        // 15 fileUploadQueue
    {} as never,                        // 16 accessControl
    {} as never,                        // 17 uploadConfig
    accountAwareDownload as never,      // 18 accountAwareDownload（可选）
    null,                               // 19 accountAwareUpload（可选）
    fileCopies as never,                // 20 fileCopies（可选）
    null,                               // 21 mirrorTrigger（可选）
  );
  return { service, getRealtimeFileStream, openStream, openSourceStream, bumpCounter, fileCopies };
}

describe('FileService.openTelegramSourceStream（回源归属 fail-closed）', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('池化失败 + 源账号兜底失败 + 来源为非默认池内账号 → 503，且默认链路一次都没被调用', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const ctx = setup({
      copies: [{ accountId: '777', telegramFileId: 'pooled-777' }],
      openStreamResult: null,
      openSourceStreamResult: null,
    });

    let caught: unknown;
    try {
      await (ctx.service as any).openTelegramSourceStream(
        makeFile({ telegramSourceAccountId: '777' }),
        1024,
      );
    } catch (error) {
      caught = error;
    }

    // 核心回归：fail-closed —— 抛结构化 503（DOWNLOAD_SERVER_BUSY），绝不落到默认 Bot
    expect(caught).toBeInstanceOf(DownloadResourceException);
    expect((caught as DownloadResourceException).errorCode).toBe('DOWNLOAD_SERVER_BUSY');
    expect((caught as DownloadResourceException).getStatus()).toBe(503);
    // 核心回归：默认链路（telegramService.getRealtimeFileStream）一次都不能被调用
    expect(ctx.getRealtimeFileStream).not.toHaveBeenCalled();
    // 本用例是「源账号兜底也失败」之后的拒绝：兜底本身先被尝试过
    expect(ctx.openStream).toHaveBeenCalledTimes(1);
    expect(ctx.openSourceStream).toHaveBeenCalledWith(expect.objectContaining({ accountId: '777' }));
    // 与 Bot 直链路径同口径计数（unresolved）
    expect(ctx.bumpCounter).toHaveBeenCalledWith('unresolved');
    // 日志：账号脱敏（777 → ***），且绝不打印 Telegram file_id
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('来源账号 ***'));
    expect(String(errorSpy.mock.calls[0][0])).not.toContain('tg-1');
  });

  it('telegramSourceAccountId 为空（历史单账号数据）→ 仍走默认链路（回退安全）', async () => {
    const ctx = setup({
      copies: [{ accountId: '777', telegramFileId: 'pooled-777' }],
      openStreamResult: null,
    });

    const result = await (ctx.service as any).openTelegramSourceStream(
      makeFile({ telegramSourceAccountId: null }),
      1024,
    );

    expect(ctx.openSourceStream).not.toHaveBeenCalled();
    expect(ctx.getRealtimeFileStream).toHaveBeenCalledTimes(1);
    expect(ctx.getRealtimeFileStream).toHaveBeenCalledWith('tg-1', 1024, { noCache: false });
    expect(result.info.file_id).toBe('legacy-file-id');
  });

  it('telegramSourceAccountId 等于默认 Bot id → 身份一致，仍走默认链路', async () => {
    const ctx = setup({
      copies: [{ accountId: DEFAULT_ACCOUNT_ID, telegramFileId: 'pooled-default' }],
      openStreamResult: null,
    });

    const result = await (ctx.service as any).openTelegramSourceStream(
      makeFile({ telegramSourceAccountId: DEFAULT_ACCOUNT_ID }),
      1024,
    );

    expect(ctx.openSourceStream).not.toHaveBeenCalled();
    expect(ctx.getRealtimeFileStream).toHaveBeenCalledTimes(1);
    expect(ctx.getRealtimeFileStream).toHaveBeenCalledWith('tg-1', 1024, { noCache: false });
    expect(result.info.file_id).toBe('legacy-file-id');
  });

  it('池化取流成功 → 直接返回池化流，不触碰源账号兜底与默认链路', async () => {
    const ctx = setup({
      copies: [{ accountId: '777', telegramFileId: 'pooled-777' }],
      openStreamResult: {
        stream: makeStream(),
        info: { file_id: 'pooled-file-id', file_size: 1024 },
        accountId: '777',
        copy: null,
        selectionReason: 'weighted',
      },
    });

    const result = await (ctx.service as any).openTelegramSourceStream(
      makeFile({ telegramSourceAccountId: '777' }),
      1024,
    );

    expect(result.info.file_id).toBe('pooled-file-id');
    expect(ctx.openSourceStream).not.toHaveBeenCalled();
    expect(ctx.getRealtimeFileStream).not.toHaveBeenCalled();
  });
});
