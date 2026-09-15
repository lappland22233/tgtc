import { HttpException, NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';
import { Request, Response } from 'express';
import { TelegramBotPublicController } from './telegram-bot-public.controller';
import { StreamSendOptions } from '../common/services/stream-responder.service';
import { RangeNotSatisfiableException } from '../file/file-utils';

const VALID_TOKEN = 'A'.repeat(43);
const TOTAL_SIZE = 1000;
const TELEGRAM_FILE_ID = 'BQACAgQAAx0-file-id';

function makeReadable(): Readable {
  return Readable.from([Buffer.from('x')]);
}

function makeRequest(overrides: Record<string, unknown> = {}): Request {
  return {
    headers: {},
    ips: [],
    ip: '203.0.113.7',
    socket: {},
    method: 'GET',
    originalUrl: `/api/bot-dl/${VALID_TOKEN}`,
    url: `/api/bot-dl/${VALID_TOKEN}`,
    ...overrides,
  } as unknown as Request;
}

function makeGrantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant-1',
    tokenPrefix: 'tgl_aaaaaaaa',
    telegramUserId: '7001',
    telegramFileId: TELEGRAM_FILE_ID,
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    fileSize: String(TOTAL_SIZE),
    revokedAt: null as Date | null,
    expiresAt: new Date(Date.now() + 3600_000),
    ...overrides,
  };
}

function makeController(overrides: Record<string, unknown> | null = {}) {
  let capturedError: unknown = null;
  const row = overrides === null ? null : makeGrantRow(overrides);

  const grantService = {
    findByToken: jest.fn(async (_token: string) => row),
    isActive: jest.fn((grant: { revokedAt: Date | null; expiresAt: Date }) =>
      !grant.revokedAt && grant.expiresAt.getTime() > Date.now()),
    tokenPrefixOf: jest.fn((token: string) => `tgl_${(token || '').slice(0, 8)}`),
    recordAccess: jest.fn(async (_grantId: string) => undefined),
  };
  const telegramService = {
    getRealtimeFileStream: jest.fn(async (_fileId: string, _expectedSize?: number) => ({
      stream: makeReadable(),
      info: { file_id: 'f', file_path: '/tmp/f', file_size: TOTAL_SIZE },
    })),
  };
  const fileCacheService = {
    getOrCacheStream: jest.fn(async (_fileId: string, _expectedSize: number) => ({
      stream: makeReadable(),
      fromCache: false,
    })),
    getOrCacheRangeStream: jest.fn(
      async (
        _fileId: string,
        _expectedSize: number,
        _start: number,
        _end: number,
      ): Promise<Readable | null> => makeReadable(),
    ),
  };
  const rateLimitService = {
    checkAndIncrement: jest.fn(
      async (_key: string, _type: string, _max: number, _lockMs: number, _windowMs: number) => ({
        allowed: true,
      }),
    ),
  };
  const streamResponder = {
    send: jest.fn(async (_options: StreamSendOptions) => undefined),
    handleError: jest.fn((_res: Response, error: unknown) => {
      capturedError = error;
    }),
  };
  const auditService = { log: jest.fn((_payload: Record<string, unknown>) => undefined) };

  const controller = new TelegramBotPublicController(
    grantService as never,
    telegramService as never,
    fileCacheService as never,
    rateLimitService as never,
    streamResponder as never,
    auditService as never,
  );

  /** 取最近一次 send 的参数（未调用时直接失败，避免误判） */
  const lastSend = (): StreamSendOptions => {
    const call = streamResponder.send.mock.calls.at(-1);
    if (!call) throw new Error('streamResponder.send 未被调用');
    return call[0];
  };

  return {
    controller,
    grantService,
    telegramService,
    fileCacheService,
    rateLimitService,
    streamResponder,
    auditService,
    lastSend,
    getCapturedError: () => capturedError,
    clearCapturedError: () => { capturedError = null; },
  };
}

const res = {} as Response;

describe('TelegramBotPublicController 匿名直链', () => {
  it('无 Range 时走缓存完整传输：200 + Content-Length + Accept-Ranges', async () => {
    const ctx = makeController();
    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    expect(ctx.fileCacheService.getOrCacheStream).toHaveBeenCalledTimes(1);
    const [cacheKey, size] = ctx.fileCacheService.getOrCacheStream.mock.calls[0];
    expect(cacheKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(size).toBe(TOTAL_SIZE);

    const sendArgs = ctx.lastSend();
    expect(sendArgs.status).toBeUndefined();
    expect(sendArgs.range).toBeUndefined();
    expect(sendArgs.headers?.['Content-Length']).toBe(String(TOTAL_SIZE));
    expect(sendArgs.headers?.['Accept-Ranges']).toBe('bytes');
    expect(sendArgs.headers?.['Content-Disposition']).toContain('attachment');
    expect(ctx.getCapturedError()).toBeNull();
  });

  it('Range 命中返回真实 206（断点续传可用）', async () => {
    const ctx = makeController();
    await ctx.controller.download(VALID_TOKEN, makeRequest({ headers: { range: 'bytes=100-199' } }), res);

    const rangeCall = ctx.fileCacheService.getOrCacheRangeStream.mock.calls[0];
    expect(rangeCall[1]).toBe(TOTAL_SIZE);
    expect(rangeCall[2]).toBe(100);
    expect(rangeCall[3]).toBe(199);

    const sendArgs = ctx.lastSend();
    expect(sendArgs.status).toBe(206);
    expect(sendArgs.range).toEqual({ start: 100, end: 199, total: TOTAL_SIZE });
    expect(sendArgs.headers?.['Content-Length']).toBe('100');
    expect(sendArgs.headers?.['Accept-Ranges']).toBe('bytes');
    // 完整下载路径不得被调用
    expect(ctx.fileCacheService.getOrCacheStream).not.toHaveBeenCalled();
  });

  it('开放式 Range（bytes=500-）的 end 钳制到 size-1', async () => {
    const ctx = makeController();
    await ctx.controller.download(VALID_TOKEN, makeRequest({ headers: { range: 'bytes=500-' } }), res);

    const sendArgs = ctx.lastSend();
    expect(sendArgs.status).toBe(206);
    expect(sendArgs.range).toEqual({ start: 500, end: TOTAL_SIZE - 1, total: TOTAL_SIZE });
    expect(sendArgs.headers?.['Content-Length']).toBe(String(TOTAL_SIZE - 500));
  });

  it('相同 Telegram 文件多次访问复用同一缓存键（稳定派生）', async () => {
    const first = makeController();
    await first.controller.download(VALID_TOKEN, makeRequest(), res);
    const second = makeController();
    await second.controller.download(VALID_TOKEN, makeRequest(), res);

    expect(first.fileCacheService.getOrCacheStream.mock.calls[0][0])
      .toBe(second.fileCacheService.getOrCacheStream.mock.calls[0][0]);
  });

  it('越界 Range 统一 416（含 total），且不触碰缓存/回源', async () => {
    const ctx = makeController();
    await ctx.controller.download(VALID_TOKEN, makeRequest({ headers: { range: 'bytes=5000-' } }), res);

    const error = ctx.getCapturedError();
    expect(error).toBeInstanceOf(RangeNotSatisfiableException);
    expect((error as RangeNotSatisfiableException).total).toBe(TOTAL_SIZE);
    expect(ctx.fileCacheService.getOrCacheRangeStream).not.toHaveBeenCalled();
    expect(ctx.fileCacheService.getOrCacheStream).not.toHaveBeenCalled();
    expect(ctx.streamResponder.send).not.toHaveBeenCalled();
  });

  it('多区间 Range 同样按不可满足处理（416）', async () => {
    const ctx = makeController();
    await ctx.controller.download(VALID_TOKEN, makeRequest({ headers: { range: 'bytes=0-1,5-6' } }), res);

    expect(ctx.getCapturedError()).toBeInstanceOf(RangeNotSatisfiableException);
  });

  it('缓存层无法给出区间流时回退 416', async () => {
    const ctx = makeController();
    ctx.fileCacheService.getOrCacheRangeStream.mockResolvedValue(null);
    await ctx.controller.download(VALID_TOKEN, makeRequest({ headers: { range: 'bytes=0-9' } }), res);

    expect(ctx.getCapturedError()).toBeInstanceOf(RangeNotSatisfiableException);
  });

  it('总长未知时退化为完整直连传输，不声明 Accept-Ranges', async () => {
    const ctx = makeController({ fileSize: null });
    await ctx.controller.download(VALID_TOKEN, makeRequest({ headers: { range: 'bytes=0-99' } }), res);

    expect(ctx.telegramService.getRealtimeFileStream).toHaveBeenCalledWith(TELEGRAM_FILE_ID);
    expect(ctx.fileCacheService.getOrCacheRangeStream).not.toHaveBeenCalled();
    expect(ctx.fileCacheService.getOrCacheStream).not.toHaveBeenCalled();

    const sendArgs = ctx.lastSend();
    expect(sendArgs.status).toBeUndefined();
    expect(sendArgs.headers?.['Accept-Ranges']).toBeUndefined();
    expect(sendArgs.headers?.['Content-Length']).toBeUndefined();
  });

  it('未知 MIME 回退 application/octet-stream（防头注入）', async () => {
    const ctx = makeController({ mimeType: 'text/html\r\nX-Evil: 1' });
    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    expect(ctx.lastSend().headers?.['Content-Type']).toBe('application/octet-stream');
  });

  it('限流不允许时返回 429', async () => {
    const ctx = makeController();
    ctx.rateLimitService.checkAndIncrement.mockResolvedValue({ allowed: false });
    await expect(ctx.controller.download(VALID_TOKEN, makeRequest(), res)).rejects.toBeInstanceOf(HttpException);
  });

  it('无记录或已撤销一律 404（防枚举，不触发回源）', async () => {
    const missing = makeController(null);
    await expect(missing.controller.download(VALID_TOKEN, makeRequest(), res)).rejects.toBeInstanceOf(NotFoundException);
    expect(missing.telegramService.getRealtimeFileStream).not.toHaveBeenCalled();

    const revoked = makeController({ revokedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) });
    await expect(revoked.controller.download(VALID_TOKEN, makeRequest(), res)).rejects.toBeInstanceOf(NotFoundException);

    const expired = makeController({ expiresAt: new Date(Date.now() - 1000) });
    await expect(expired.controller.download(VALID_TOKEN, makeRequest(), res)).rejects.toBeInstanceOf(NotFoundException);

    const malformed = makeController();
    await expect(malformed.controller.download('short', makeRequest(), res)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('成功与失败均写入访问审计，且不记录完整 Token', async () => {
    const ctx = makeController();
    await ctx.controller.download(VALID_TOKEN, makeRequest({ headers: { range: 'bytes=0-9' } }), res);

    const successLog = ctx.auditService.log.mock.calls[0][0];
    expect(successLog.action).toBe('telegram_bot_link_accessed');
    // 审计取 DB 中的 tokenPrefix 快照（非由请求 Token 重新推导）
    expect(successLog.metadata).toMatchObject({ ranged: true, tokenPrefix: 'tgl_aaaaaaaa' });
    expect(JSON.stringify(successLog)).not.toContain(VALID_TOKEN);

    ctx.fileCacheService.getOrCacheStream.mockRejectedValue(new Error('upstream down'));
    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    const failureLog = ctx.auditService.log.mock.calls[1][0];
    expect(failureLog.status).toBe('failure');
    expect((failureLog.metadata as { success: boolean }).success).toBe(false);
  });
});
