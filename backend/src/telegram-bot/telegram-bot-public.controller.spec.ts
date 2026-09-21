import { HttpException, NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';
import { Request, Response } from 'express';
import { TelegramBotPublicController } from './telegram-bot-public.controller';
import { StreamSendOptions } from '../common/services/stream-responder.service';
import { buildOpaqueETag } from '../common/utils/file-range-validator';
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
    // 未知大小的有界直通：真实实现会调用 fetchFn 取上游流，这里保持同一契约
    getDirectOnlyStream: jest.fn(async (
      _sessionKey: string,
      fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
    ): Promise<Readable> => (await fetchFn()).stream),
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

/** 控制器会在分发前用 res.set 预写 ETag（保证 416 也带上版本标识），桩需支持 */
const res = { set: jest.fn() } as unknown as Response;

describe('TelegramBotPublicController 匿名直链', () => {
  beforeEach(() => {
    (res.set as jest.Mock).mockClear();
  });

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
    expect(successLog.metadata).toMatchObject({
      ranged: true,
      tokenPrefix: 'tgl_aaaaaaaa',
      terminationReason: 'completed',
    });
    expect(JSON.stringify(successLog)).not.toContain(VALID_TOKEN);

    ctx.fileCacheService.getOrCacheStream.mockRejectedValue(new Error('upstream down'));
    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    const failureLog = ctx.auditService.log.mock.calls[1][0];
    expect(failureLog.status).toBe('failure');
    expect((failureLog.metadata as { success: boolean }).success).toBe(false);
    // 失败请求不得计入访问次数（历史缺陷：输出前就计数，中断也算一次下载）
    expect(ctx.grantService.recordAccess).toHaveBeenCalledTimes(1);
  });

  it('完整下载返回稳定强 ETag，并计入访问次数', async () => {
    const ctx = makeController();
    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    const expected = buildOpaqueETag('telegram-bot', TELEGRAM_FILE_ID, TOTAL_SIZE);
    expect(expected.startsWith('"') && expected.endsWith('"')).toBe(true);
    expect(ctx.lastSend().headers?.['ETag']).toBe(expected);
    expect(res.set).toHaveBeenCalledWith('ETag', expected);
    expect(ctx.grantService.recordAccess).toHaveBeenCalledTimes(1);
  });

  it('同一 Telegram 文件的 ETag 跨不同授权保持一致', async () => {
    const first = makeController({ id: 'grant-a', tokenPrefix: 'tgl_a' });
    await first.controller.download(VALID_TOKEN, makeRequest(), res);
    const second = makeController({ id: 'grant-b', tokenPrefix: 'tgl_b' });
    await second.controller.download(VALID_TOKEN, makeRequest(), res);

    expect(first.lastSend().headers?.['ETag']).toBe(second.lastSend().headers?.['ETag']);
  });

  it('206 与 200 返回同一个 ETag', async () => {
    const full = makeController();
    await full.controller.download(VALID_TOKEN, makeRequest(), res);
    const partial = makeController();
    await partial.controller.download(VALID_TOKEN, makeRequest({ headers: { range: 'bytes=0-9' } }), res);

    expect(partial.lastSend().status).toBe(206);
    expect(partial.lastSend().headers?.['ETag']).toBe(full.lastSend().headers?.['ETag']);
  });

  it('If-Range 强 ETag 精确匹配时按 Range 返回 206', async () => {
    const ctx = makeController();
    const etag = buildOpaqueETag('telegram-bot', TELEGRAM_FILE_ID, TOTAL_SIZE);
    await ctx.controller.download(
      VALID_TOKEN,
      makeRequest({ headers: { range: 'bytes=100-199', 'if-range': etag } }),
      res,
    );

    expect(ctx.lastSend().status).toBe(206);
    expect(ctx.fileCacheService.getOrCacheRangeStream).toHaveBeenCalledTimes(1);
    expect(ctx.fileCacheService.getOrCacheStream).not.toHaveBeenCalled();
  });

  it('If-Range 不匹配时忽略 Range 回完整 200（避免拼接不同版本）', async () => {
    const ctx = makeController();
    await ctx.controller.download(
      VALID_TOKEN,
      makeRequest({ headers: { range: 'bytes=100-199', 'if-range': '"stale-version"' } }),
      res,
    );

    expect(ctx.fileCacheService.getOrCacheRangeStream).not.toHaveBeenCalled();
    expect(ctx.fileCacheService.getOrCacheStream).toHaveBeenCalledTimes(1);
    const sendArgs = ctx.lastSend();
    expect(sendArgs.status).toBeUndefined();
    expect(sendArgs.range).toBeUndefined();
    expect(sendArgs.headers?.['Content-Length']).toBe(String(TOTAL_SIZE));
  });

  it('弱 ETag 与日期形式的 If-Range 同样回完整 200', async () => {
    const etag = buildOpaqueETag('telegram-bot', TELEGRAM_FILE_ID, TOTAL_SIZE);
    for (const ifRange of [`W/${etag}`, 'Wed, 21 Oct 2015 07:28:00 GMT']) {
      const ctx = makeController();
      await ctx.controller.download(
        VALID_TOKEN,
        makeRequest({ headers: { range: 'bytes=0-9', 'if-range': ifRange } }),
        res,
      );
      expect(ctx.lastSend().status).toBeUndefined();
      expect(ctx.fileCacheService.getOrCacheStream).toHaveBeenCalledTimes(1);
    }
  });

  it('无 If-Range 的 Range 请求仍返回 206', async () => {
    const ctx = makeController();
    await ctx.controller.download(VALID_TOKEN, makeRequest({ headers: { range: 'bytes=0-9' } }), res);
    expect(ctx.lastSend().status).toBe(206);
  });

  it('总长未知时不声明 ETag 与 Accept-Ranges', async () => {
    const ctx = makeController({ fileSize: null });
    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    const sendArgs = ctx.lastSend();
    expect(sendArgs.headers?.['ETag']).toBeUndefined();
    expect(sendArgs.headers?.['Accept-Ranges']).toBeUndefined();
    expect(res.set).not.toHaveBeenCalled();
  });

  it('416 也携带 ETag，便于客户端刷新本地版本', async () => {
    const ctx = makeController();
    await ctx.controller.download(VALID_TOKEN, makeRequest({ headers: { range: 'bytes=5000-' } }), res);

    expect(res.set).toHaveBeenCalledWith(
      'ETag',
      buildOpaqueETag('telegram-bot', TELEGRAM_FILE_ID, TOTAL_SIZE),
    );
  });

  it('限流键使用不可逆摘要，不落明文 Token', async () => {
    const ctx = makeController();
    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    const tokenKey = ctx.rateLimitService.checkAndIncrement.mock.calls
      .map((call) => String(call[0]))
      .find((key) => key.startsWith('bot-dl:token:'));
    expect(tokenKey).toBeDefined();
    expect(tokenKey).not.toContain(VALID_TOKEN);
    expect(String(tokenKey).replace('bot-dl:token:', '')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('传输结果上下文：标记为可分类下载并记录分段与结束原因', async () => {
    const ctx = makeController();
    const request = makeRequest({ headers: { range: 'bytes=0-9' } });
    await ctx.controller.download(VALID_TOKEN, request, res);

    const tracked = request as unknown as {
      transferTracked?: boolean;
      ranged?: boolean;
      terminationReason?: string;
    };
    expect(tracked.transferTracked).toBe(true);
    expect(tracked.ranged).toBe(true);
  });

  it('源流失败时同步分类结束原因（不误记为客户端中断）', async () => {
    const ctx = makeController();
    ctx.fileCacheService.getOrCacheStream.mockResolvedValue({
      stream: Readable.from([Buffer.from('x')]),
      fromCache: false,
    });
    // 模拟真实 pipeline：源流先 emit 'error'，随后 send 以中断异常 reject
    ctx.streamResponder.send.mockImplementation(async (options: StreamSendOptions) => {
      options.stream.emit('error', new Error('缓存构建空闲超时（60000ms）'));
      throw new Error('premature close');
    });

    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    const failureLog = ctx.auditService.log.mock.calls.at(-1)?.[0];
    expect(failureLog?.status).toBe('failure');
    // 结束原因取源流的同步分类（timeout），而不是外层中断异常的 client_abort
    expect((failureLog?.metadata as { terminationReason?: string }).terminationReason).toBe('timeout');
    expect(ctx.grantService.recordAccess).not.toHaveBeenCalled();
  });
});

describe('TelegramBotPublicController 账号池回退矩阵（fail-closed）', () => {
  const DEFAULT_BOT_TOKEN = '1234567:DEFAULT-TOKEN';

  function makePoolController(options: {
    poolActive?: boolean;
    sourceAccountId?: string | null;
    anchor?: { ownerType: string; ownerId: string } | null;
    openStreamResult?: 'ok' | 'null';
    sourceStreamResult?: 'ok' | 'null';
    anchorThrows?: boolean;
    hasSourceAccount?: boolean;
  } = {}) {
    let capturedError: unknown = null;
    const counters: Record<string, number> = { unresolved: 0, fallbacks: 0 };

    const grantService = {
      findByToken: jest.fn(async () => ({
        id: 'grant-1',
        tokenPrefix: 'tgl_aaaaaaaa',
        telegramUserId: '7001',
        telegramFileId: TELEGRAM_FILE_ID,
        sourceAccountId: options.sourceAccountId === undefined ? '9999999' : options.sourceAccountId,
        chatId: '7001',
        messageId: '100',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        fileSize: String(TOTAL_SIZE),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 3600_000),
      })),
      isActive: jest.fn(() => true),
      recordAccess: jest.fn(async () => undefined),
    };
    const telegramService = {
      getRealtimeFileStream: jest.fn(async () => ({
        stream: makeReadable(),
        info: { file_id: 'f', file_size: TOTAL_SIZE },
      })),
    };
    const fileCacheService = {
      getOrCacheStream: jest.fn(async (
        _key: string,
        _size: number,
        fetchFn: () => Promise<{ stream: Readable }>,
      ) => ({ stream: (await fetchFn()).stream, fromCache: false })),
      getOrCacheRangeStream: jest.fn(),
      getDirectOnlyStream: jest.fn(),
    };
    const rateLimitService = { checkAndIncrement: jest.fn(async () => ({ allowed: true })) };
    const streamResponder = {
      send: jest.fn(async () => undefined),
      handleError: jest.fn((_res: Response, error: unknown) => { capturedError = error; }),
    };
    const auditService = { log: jest.fn() };
    const fileCopies = {
      findByAnchor: options.anchorThrows
        ? jest.fn(async () => { throw new Error('副本表不可用'); })
        : jest.fn(async () => (options.anchor === undefined ? { ownerType: 'fileUnique', ownerId: 'UNIQ-1' } : options.anchor)),
    };
    const accountPoolDownload = {
      isActive: jest.fn(() => options.poolActive ?? true),
      inactiveReason: jest.fn(() => null),
      hasAccount: jest.fn(() => options.hasSourceAccount ?? true),
      bumpCounter: jest.fn((key: string, delta = 1) => { counters[key] = (counters[key] ?? 0) + delta; }),
      openStream: jest.fn(async () => (options.openStreamResult === 'ok'
        ? { stream: makeReadable(), info: { file_id: 'pooled', file_size: TOTAL_SIZE }, accountId: '2222222', copy: null, selectionReason: 'weighted' }
        : null)),
      openSourceStream: jest.fn(async () => (options.sourceStreamResult === 'ok'
        ? { stream: makeReadable(), info: { file_id: 'source', file_size: TOTAL_SIZE }, accountId: '9999999', copy: null, selectionReason: 'source-account-fallback' }
        : null)),
    };
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'TELEGRAM_BOT_TOKEN') return DEFAULT_BOT_TOKEN;
        if (key === 'TELEGRAM_POOL_TARGET_REPLICAS') return '2';
        return '';
      }),
    };

    const controller = new TelegramBotPublicController(
      grantService as never,
      telegramService as never,
      fileCacheService as never,
      rateLimitService as never,
      streamResponder as never,
      auditService as never,
      accountPoolDownload as never,
      fileCopies as never,
      configService as never,
    );

    return {
      controller,
      counters,
      grantService,
      telegramService,
      fileCacheService,
      accountPoolDownload,
      fileCopies,
      configService,
      getCapturedError: () => capturedError,
    };
  }

  it('池化可用时按负载回源，不触碰单账号链路', async () => {
    const ctx = makePoolController({ openStreamResult: 'ok' });
    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    expect(ctx.accountPoolDownload.openStream).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: 'fileUnique',
      ownerId: 'UNIQ-1',
      desiredReplicas: 2,
    }));
    // 池化成功：不得再调用默认账号
    expect(ctx.telegramService.getRealtimeFileStream).not.toHaveBeenCalled();
    expect(ctx.getCapturedError()).toBeNull();
  });

  it('池化失败但源账号可确认：用源账号回源并记回退计数', async () => {
    const ctx = makePoolController({ openStreamResult: 'null', sourceStreamResult: 'ok', sourceAccountId: '9999999' });
    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    expect(ctx.accountPoolDownload.openSourceStream).toHaveBeenCalledWith({
      accountId: '9999999',
      fileId: TELEGRAM_FILE_ID,
      expectedSize: TOTAL_SIZE,
      noCache: true,
    });
    expect(ctx.counters.fallbacks).toBe(1);
    expect(ctx.telegramService.getRealtimeFileStream).not.toHaveBeenCalled();
    expect(ctx.getCapturedError()).toBeNull();
  });

  it('副本表暂时不可用但源账号可确认：仍回退源账号（不阻断可用性）', async () => {
    const ctx = makePoolController({ anchorThrows: true, sourceStreamResult: 'ok', sourceAccountId: '9999999' });
    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    expect(ctx.accountPoolDownload.openSourceStream).toHaveBeenCalledTimes(1);
    expect(ctx.telegramService.getRealtimeFileStream).not.toHaveBeenCalled();
  });

  it('归属不明（sourceAccountId 为空）：拒绝跨账号回退并返回可诊断失败', async () => {
    const ctx = makePoolController({ openStreamResult: 'null', sourceAccountId: null });
    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    expect(ctx.accountPoolDownload.openSourceStream).not.toHaveBeenCalled();
    expect(ctx.telegramService.getRealtimeFileStream).not.toHaveBeenCalled();
    expect(ctx.counters.unresolved).toBe(1);
    const error = ctx.getCapturedError();
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(503);
  });

  it('源账号不在池内且与默认账号不一致：同样拒绝回退默认账号', async () => {
    const ctx = makePoolController({
      openStreamResult: 'null',
      sourceAccountId: '8888888',
      hasSourceAccount: false,
    });
    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    expect(ctx.telegramService.getRealtimeFileStream).not.toHaveBeenCalled();
    expect((ctx.getCapturedError() as HttpException)?.getStatus()).toBe(503);
  });

  it('源账号不在池内但等于默认 Token 的账号：按单账号链路回源（身份一致）', async () => {
    const ctx = makePoolController({
      openStreamResult: 'null',
      sourceAccountId: '1234567',
      hasSourceAccount: false,
    });
    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    expect(ctx.telegramService.getRealtimeFileStream).toHaveBeenCalledWith(
      TELEGRAM_FILE_ID,
      TOTAL_SIZE,
      { noCache: true },
    );
    expect(ctx.getCapturedError()).toBeNull();
  });

  it('账号池未启用：保持原单账号链路，且不查询副本表', async () => {
    const ctx = makePoolController({ poolActive: false });
    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    expect(ctx.fileCopies.findByAnchor).not.toHaveBeenCalled();
    expect(ctx.accountPoolDownload.openStream).not.toHaveBeenCalled();
    expect(ctx.telegramService.getRealtimeFileStream).toHaveBeenCalledWith(
      TELEGRAM_FILE_ID,
      TOTAL_SIZE,
      { noCache: true },
    );
  });
});
