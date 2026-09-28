// file-type 已在 jest.config moduleNameMapper 中映射为 CJS 桩（ESM-only 包）。
import { ForbiddenException, HttpException, RequestMethod } from '@nestjs/common';
import { EventEmitter } from 'events';
import { Request, Response } from 'express';
import { FileController, assertSameOriginWrite, PUBLIC_MEDIA_SMALL_FILE_THRESHOLD_BYTES } from './file.controller';
import { PublicMediaAdmissionService } from '../common/services/public-media-admission.service';

/**
 * P1-10 回归：download-link 为写语义端点（permanent 会将私有文件转公开），
 * 必须只接受 POST——认证 Cookie 为 SameSite=Lax，跨站顶层导航 GET 会携带
 * Cookie 且无 CSRF 防护，曾被诱导访问 GET 路由静默转公开。
 */
describe('FileController download-link 路由（P1-10 CSRF 回归）', () => {
  it('download-link 只映射 POST，旧 GET 路由不再存在', () => {
    const pathMetadata = Reflect.getMetadata('path', FileController.prototype.getDownloadLink) as string;
    const methodMetadata = Reflect.getMetadata('method', FileController.prototype.getDownloadLink) as RequestMethod;
    expect(pathMetadata).toBe(':id/download-link');
    expect(methodMetadata).toBe(RequestMethod.POST);
  });

  describe('assertSameOriginWrite（同源校验纵深防御）', () => {
    function makeRequest(headers: Record<string, string>, hostname: string): Request {
      return { headers, hostname } as unknown as Request;
    }

    it('非浏览器客户端（无 Origin/Referer）放行', () => {
      expect(() => assertSameOriginWrite(makeRequest({}, 'files.example.com'))).not.toThrow();
    });

    it('跨站 Origin 被拒绝（403）', () => {
      expect(() =>
        assertSameOriginWrite(makeRequest({ origin: 'https://evil.example' }, 'files.example.com')),
      ).toThrow(ForbiddenException);
    });

    it('跨站 Referer 兜底校验被拒绝（403）', () => {
      expect(() =>
        assertSameOriginWrite(makeRequest({ referer: 'https://evil.example/attack' }, 'files.example.com')),
      ).toThrow(ForbiddenException);
    });

    it('同源 Origin 放行（忽略 scheme，兼容反代 TLS 终止）', () => {
      expect(() =>
        assertSameOriginWrite(makeRequest({ origin: 'https://files.example.com' }, 'files.example.com')),
      ).not.toThrow();
    });

    it('非法 Origin 头被拒绝（403）', () => {
      expect(() =>
        assertSameOriginWrite(makeRequest({ origin: 'not-a-url' }, 'files.example.com')),
      ).toThrow(ForbiddenException);
    });
  });
});

function buildMediaController(
  fileSize: number,
  ip = '198.51.100.42',
  sharedAdmission?: PublicMediaAdmissionService,
) {
  let finishSend!: () => void;
  const sendFinished = new Promise<void>((resolve) => { finishSend = resolve; });
  const service = Object.create(FileController.prototype) as any;
  service.fileService = {
    getPublicMediaMetadata: jest.fn().mockResolvedValue({ size: fileSize }),
    getPublicMediaStream: jest.fn().mockResolvedValue({
      stream: new EventEmitter(),
      size: fileSize,
      filename: 'image.png',
      contentType: 'image/png',
      etag: '"test"',
    }),
    getPublicMediaStreamWithRange: jest.fn().mockResolvedValue(null),
  };
  service.rateLimitService = { checkAndIncrement: jest.fn().mockResolvedValue({ allowed: true }) };
  const admission = new PublicMediaAdmissionService();
  service.publicMediaAdmission = sharedAdmission ?? new PublicMediaAdmissionService();
  service.streamResponder = { send: jest.fn().mockReturnValue(sendFinished), handleError: jest.fn() };
  const req = {
    headers: {},
    ip,
    ips: [],
    socket: { remoteAddress: ip },
    method: 'GET',
    originalUrl: '/api/files/media/test-id',
    url: '/api/files/media/test-id',
  } as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    headersSent: false,
    status: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    json: jest.fn(),
    destroy: jest.fn(),
  }) as unknown as Response & EventEmitter;
  const complete = () => {
    res.emit('close');
    finishSend();
  };
  const request = (id = 'test-id') => service.getPublicMedia(id, req, res);
  return {
    service,
    fileService: service.fileService,
    rateLimitService: service.rateLimitService,
    streamResponder: service.streamResponder,
    admission,
    req,
    res,
    complete,
    request,
  };
}

async function flushMediaRequestStart(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('FileController public media size-aware IP concurrency', () => {
  const sameIp = '198.51.100.42';

  it('20MB 以下媒体豁免每 IP 并发槽，但仍执行速率限制与完整流响应', async () => {
    const contexts = Array.from({ length: 8 }, () => buildMediaController(
      PUBLIC_MEDIA_SMALL_FILE_THRESHOLD_BYTES - 1,
      sameIp,
    ));
    const requests = contexts.map((context) => context.request('small-id'));
    await Promise.all(contexts.map(() => flushMediaRequestStart()));

    for (const { service, res } of contexts) {
      expect(service.rateLimitService.checkAndIncrement).toHaveBeenCalled();
      expect(service.fileService.getPublicMediaMetadata).toHaveBeenCalledWith('small-id');
      expect(service.fileService.getPublicMediaStream).toHaveBeenCalledWith('small-id', sameIp);
      expect(service.streamResponder.send).toHaveBeenCalledTimes(1);
      res.emit('close');
    }
    await Promise.all(contexts.map((context) => context.complete()));
    await Promise.all(requests);
  });

  it('恰好 20,000,000 bytes 仍受每 IP 4 槽保护，第 5 个请求返回 429', async () => {
    const firstFour = Array.from({ length: 4 }, () => buildMediaController(
      PUBLIC_MEDIA_SMALL_FILE_THRESHOLD_BYTES,
      sameIp,
    ));
    const firstFourRequests = firstFour.map((context) => context.request('large-id'));
    await Promise.all(firstFour.map(() => flushMediaRequestStart()));

    for (const { service } of firstFour) {
      expect(service.fileService.getPublicMediaStream).toHaveBeenCalledTimes(1);
      expect(service.streamResponder.send).toHaveBeenCalledTimes(1);
    }

    const fifth = buildMediaController(PUBLIC_MEDIA_SMALL_FILE_THRESHOLD_BYTES, sameIp);
    await fifth.request('large-id');
    expect(fifth.fileService.getPublicMediaMetadata).toHaveBeenCalledWith('large-id');
    expect(fifth.fileService.getPublicMediaStream).not.toHaveBeenCalled();
    expect(fifth.streamResponder.send).not.toHaveBeenCalled();
    expect(fifth.streamResponder.handleError).toHaveBeenCalledWith(
      fifth.res,
      expect.any(HttpException),
      '媒体文件访问失败',
      fifth.req,
    );

    await Promise.all(firstFour.map((context) => context.complete()));
    await Promise.all(firstFourRequests);

    const slotWasReleased = buildMediaController(PUBLIC_MEDIA_SMALL_FILE_THRESHOLD_BYTES, sameIp);
    const releasedRequest = slotWasReleased.request('large-id');
    await flushMediaRequestStart();
    expect(slotWasReleased.streamResponder.send).toHaveBeenCalledTimes(1);
    await slotWasReleased.complete();
    await releasedRequest;
  });

  it('metadata 授权预检失败时不打开媒体流、不占并发槽', async () => {
    const context = buildMediaController(PUBLIC_MEDIA_SMALL_FILE_THRESHOLD_BYTES, sameIp);
    context.service.fileService.getPublicMediaMetadata.mockRejectedValue(new ForbiddenException());

    await context.request('private-id');

    expect(context.service.fileService.getPublicMediaStream).not.toHaveBeenCalled();
    expect(context.service.fileService.getPublicMediaStreamWithRange).not.toHaveBeenCalled();
    expect(context.service.streamResponder.handleError).toHaveBeenCalledTimes(1);
  });

  it('Range 冷回源同样按总文件大小计数并共享同一 per-IP 槽', async () => {
    const context = buildMediaController(PUBLIC_MEDIA_SMALL_FILE_THRESHOLD_BYTES, sameIp);
    context.req.headers.range = 'bytes=0-9';
    context.service.fileService.getPublicMediaStreamWithRange.mockResolvedValue({
      stream: new EventEmitter(),
      size: 10,
      start: 0,
      end: 9,
      total: PUBLIC_MEDIA_SMALL_FILE_THRESHOLD_BYTES,
      contentType: 'image/png',
      filename: 'image.png',
      etag: '"test"',
    });
    const request = context.request('range-id');
    await flushMediaRequestStart();
    await flushMediaRequestStart();

    expect(context.service.fileService.getPublicMediaStreamWithRange).toHaveBeenCalledWith(
      'range-id', 'bytes=0-9', sameIp, undefined,
    );
    expect(context.service.streamResponder.send).toHaveBeenCalledWith(expect.objectContaining({ status: 206 }));
    await context.complete();
    await request;
  });

  it('进程级媒体并发达到上限时拒绝新响应，并在既有响应结束后释放名额', async () => {
    const admission = new PublicMediaAdmissionService();
    const occupied = Array.from({ length: 128 }, () => buildMediaController(
      PUBLIC_MEDIA_SMALL_FILE_THRESHOLD_BYTES - 1,
      sameIp,
      admission,
    ));
    const requests = occupied.map((context) => context.request('small-id'));
    await Promise.all(occupied.map(() => flushMediaRequestStart()));
    expect(admission.getActiveResponses()).toBe(128);

    const overloaded = buildMediaController(PUBLIC_MEDIA_SMALL_FILE_THRESHOLD_BYTES - 1, '203.0.113.7', admission);
    await overloaded.request('small-id');
    expect(overloaded.service.fileService.getPublicMediaMetadata).not.toHaveBeenCalled();
    expect(overloaded.streamResponder.handleError).toHaveBeenCalledWith(
      overloaded.res,
      expect.objectContaining({ status: 503 }),
      '媒体文件访问失败',
      overloaded.req,
    );

    await occupied[0].complete();
    await requests[0];
    const released = buildMediaController(PUBLIC_MEDIA_SMALL_FILE_THRESHOLD_BYTES - 1, '203.0.113.8', admission);
    const releasedRequest = released.request('small-id');
    await flushMediaRequestStart();
    expect(released.streamResponder.send).toHaveBeenCalledTimes(1);

    await Promise.all(occupied.slice(1).map(async (context, index) => {
      await context.complete();
      await requests[index + 1];
    }));
    await released.complete();
    await releasedRequest;
  });

  it('metadata 后发现客户端已断开时不继续取流', async () => {
    const context = buildMediaController(PUBLIC_MEDIA_SMALL_FILE_THRESHOLD_BYTES, sameIp);
    context.service.fileService.getPublicMediaMetadata.mockImplementation(async () => {
      (context.res as Response).destroyed = true;
      return { size: PUBLIC_MEDIA_SMALL_FILE_THRESHOLD_BYTES };
    });

    await context.request('disconnected-id');

    expect(context.service.fileService.getPublicMediaStream).not.toHaveBeenCalled();
    expect(context.service.fileService.getPublicMediaStreamWithRange).not.toHaveBeenCalled();
  });
});
