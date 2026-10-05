/**
 * 在线预览发布门禁 —— HTTP E2E（C-01/C-02 安全与凭据治理）。
 *
 * 用真实中间件 + 真实 Controller + mock 业务依赖，通过 Supertest 发出真实 HTTP 请求：
 * 1. 访问日志不再持久化 query 凭据（脱敏）。
 * 2. 分享密码验证签发 HttpOnly Cookie。
 * 3. 危险 MIME（SVG）在公开媒体直链被拒绝。
 * 4. 媒体响应带 nosniff / no-referrer / 限制性 CSP / no-store。
 */
jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }), { virtual: true });

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Readable } from 'stream';

import { AccessLogMiddleware } from '../src/common/middleware/access-log.middleware';
import { CsrfGuard } from '../src/common/guards/csrf.guard';
import { GlobalExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { StreamResponderService } from '../src/common/services/stream-responder.service';
import { MediaTicketService } from '../src/common/services/media-ticket.service';
import { PublicMediaAdmissionService } from '../src/common/services/public-media-admission.service';
import { ShareController } from '../src/share/share.controller';
import { ShareService } from '../src/share/share.service';
import { FileController } from '../src/file/file.controller';
import { FileService } from '../src/file/file.service';
import { RateLimitService } from '../src/common/services/rate-limit.service';
import { ConfigCacheService } from '../src/common/services/config-cache.service';
import { ThumbnailCryptoService } from '../src/file/thumbnail-crypto.service';
import { TagService } from '../src/tag/tag.service';
import { FolderService } from '../src/folder/folder.service';
import { DownloadTaskService } from '../src/file/download-task.service';
import { FileCacheService } from '../src/file/file-cache.service';
import { UploadDiskBudgetService } from '../src/file/upload-disk-budget.service';
import { FileAccessType } from '../src/common/entities/file.entity';

type AnyMock = jest.Mock<(...args: any[]) => any>;
const mockFunction = (): AnyMock => jest.fn<(...args: any[]) => any>();

// ---------- 日志脱敏：真实 Express 请求 + 真实持久化中间件 ----------

describe('访问日志脱敏（C-02）', () => {
  let app: express.Express;
  let middleware: AccessLogMiddleware;
  let repo: { insert: AnyMock };

  beforeAll(() => {
    repo = { insert: mockFunction().mockResolvedValue(undefined) };
    middleware = new AccessLogMiddleware(repo as never);
    app = express();
    app.use((req, res, next) => middleware.use(req, res, next));
    app.get('/api/s/:token/preview/:fileId', (_req, res) => res.status(200).json({ ok: true }));
  });

  it('真实 HTTP 请求成功，且持久化访问日志不含任何 query 凭据', async () => {
    const credentials = [
      'jwt.header.signature',
      'media-ticket-secret',
      'password-query-secret',
      'refresh-token-secret',
    ];
    const res = await request(app)
      .get(
        '/api/s/path-share-secret/preview/file-123' +
          '?access=jwt.header.signature' +
          '&ticket=media-ticket-secret' +
          '&password=password-query-secret' +
          '&refresh_token=refresh-token-secret' +
          '&view=keep-me',
      )
      .set('Referer', 'https://preview.example/share?access=referer-query-secret')
      .expect(200);

    expect(res.body).toEqual({ ok: true });
    await middleware.onApplicationShutdown();

    expect(repo.insert).toHaveBeenCalledTimes(1);
    const persisted = repo.insert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0].path).toBe('/api/s/[REDACTED]/preview/file-123?view=keep-me');
    expect(persisted[0].referer).toBe('https://preview.example/share');

    const serializedPersistence = JSON.stringify(persisted);
    for (const credential of [...credentials, 'referer-query-secret', 'path-share-secret']) {
      expect(serializedPersistence).not.toContain(credential);
    }
    expect(serializedPersistence).toContain('keep-me');
  });

  afterAll(async () => {
    await middleware.onApplicationShutdown();
  });
});

// ---------- 分享 Cookie 签发 + 媒体安全头（真实 Nest HTTP 中间件 / Controller） ----------

describe('分享 Cookie 与媒体安全头（C-01/C-02）', () => {
  let app: INestApplication;
  let shareService: Record<string, AnyMock>;
  let fileService: FileService;
  let fileRepository: { findOne: AnyMock };
  let getPublicMediaStream: AnyMock;

  const svgId = '11111111-1111-4111-8111-111111111111';
  const pngId = '22222222-2222-4222-8222-222222222222';
  const pngBytes = Buffer.from('safe png fixture');

  beforeAll(async () => {
    shareService = {
      getSharePublicInfo: mockFunction().mockResolvedValue({ requiresPassword: false, targetType: 'file' }),
      verifyPassword: mockFunction().mockResolvedValue({ accessJwt: 'jwt.header.payload' }),
      getShareThumbnailStream: mockFunction(),
      getShareHdThumbnailStream: mockFunction(),
      getShareCacheStatus: mockFunction().mockResolvedValue({ status: 'cold', cached: false }),
      getShareDownloadStream: mockFunction(),
      getSharePreviewStream: mockFunction(),
      getFolderBreadcrumbForShare: mockFunction().mockResolvedValue([]),
      listFolderContentsForShare: mockFunction().mockResolvedValue({ subfolders: [], files: [] }),
    };

    const mediaFiles = new Map<string, Record<string, unknown>>([
      [svgId, {
        id: svgId,
        originalName: 'danger.svg',
        mimeType: 'image/svg+xml',
        size: 128,
        accessType: FileAccessType.PUBLIC,
        isDeleted: false,
        password: null,
        maxAccessCount: -1,
        expiresIn: null,
        status: 'ready',
      }],
      [pngId, {
        id: pngId,
        originalName: 'ok.png',
        mimeType: 'image/png',
        size: pngBytes.length,
        accessType: FileAccessType.PUBLIC,
        isDeleted: false,
        password: null,
        maxAccessCount: -1,
        expiresIn: null,
        status: 'ready',
      }],
    ]);

    // 保留真实 FileService.prototype 的 metadata/MIME/权限校验；只替换持久层和远端字节流。
    fileRepository = {
      findOne: mockFunction().mockImplementation(
        async (options: { where: { id: string } }) => mediaFiles.get(options.where.id) ?? null,
      ),
    };
    getPublicMediaStream = mockFunction();
    fileService = Object.assign(Object.create(FileService.prototype) as FileService, {
      fileRepository,
      getPublicMediaStream,
      // 仅验证 HTTP/授权路径，不启动 FileService 的目录扫描和缓存初始化生命周期任务。
      onModuleInit: undefined,
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ShareController, FileController],
      providers: [
        { provide: ShareService, useValue: shareService },
        { provide: FileService, useValue: fileService },
        {
          provide: RateLimitService,
          useValue: { checkAndIncrement: mockFunction().mockResolvedValue({ allowed: true }) },
        },
        { provide: ConfigCacheService, useValue: { get: mockFunction().mockResolvedValue(undefined) } },
        { provide: ThumbnailCryptoService, useValue: { sign: (value: string) => value, verify: () => true } },
        { provide: StreamResponderService, useClass: StreamResponderService },
        { provide: MediaTicketService, useValue: { issue: mockFunction().mockReturnValue('test-media-ticket') } },
        { provide: TagService, useValue: {} },
        { provide: FolderService, useValue: {} },
        { provide: UploadDiskBudgetService, useValue: {} },
        { provide: DownloadTaskService, useValue: {} },
        { provide: FileCacheService, useValue: {} },
        PublicMediaAdmissionService,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    // 与 main.ts 对齐：真实 Helmet / cookie-parser、CSRF Guard、验证管道及响应处理器。
    app.use(helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }));
    app.use(cookieParser());
    app.useGlobalGuards(new CsrfGuard());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    app.useGlobalInterceptors(new TransformInterceptor());
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('密码验证成功后签发 HttpOnly、SameSite=Lax 且 Path 受限的 share_access Cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/s/tok123/verify')
      .send({ password: 'secret' })
      .expect(201);
    const cookieHeader = res.headers['set-cookie'] as unknown;
    const cookies: string[] = Array.isArray(cookieHeader)
      ? cookieHeader.filter((cookie): cookie is string => typeof cookie === 'string')
      : typeof cookieHeader === 'string'
        ? [cookieHeader]
        : [];
    const accessCookie = cookies.find((cookie: string) => cookie.startsWith('share_access='));

    expect(accessCookie).toBeDefined();
    const cookieAttributes = accessCookie!.split(';').slice(1).map(attribute => attribute.trim().toLowerCase());
    expect(cookieAttributes).toContain('httponly');
    expect(cookieAttributes).toContain('samesite=lax');
    expect(cookieAttributes).toContain('path=/api/s/');
    expect(accessCookie).toContain('jwt.header.payload');
    expect(shareService.verifyPassword).toHaveBeenCalledWith('tok123', 'secret', expect.any(String));
  });

  it('真实公开媒体 metadata 校验在 HTTP 层拒绝 image/svg+xml，且不启动内容流', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/files/media/${svgId}`)
      .expect(400);

    expect(res.body).toEqual(expect.objectContaining({ code: 400, data: null }));
    expect(fileRepository.findOne).toHaveBeenCalledWith({ where: { id: svgId, isDeleted: false } });
    expect(getPublicMediaStream).not.toHaveBeenCalled();
  });

  it('合法 PNG 经真实流响应返回 nosniff、no-referrer、限制性 CSP 和 no-store', async () => {
    getPublicMediaStream.mockImplementationOnce(async () => ({
      stream: Readable.from([pngBytes]),
      contentType: 'image/png',
      filename: 'ok.png',
      size: pngBytes.length,
      accessLogId: undefined,
      etag: '"preview-e2e-png"',
    }));

    const res = await request(app.getHttpServer())
      .get(`/api/files/media/${pngId}`)
      .expect(200);

    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-length']).toBe(String(pngBytes.length));
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body).toEqual(pngBytes);
    expect(getPublicMediaStream).toHaveBeenCalledWith(pngId, expect.any(String));
  });
});
