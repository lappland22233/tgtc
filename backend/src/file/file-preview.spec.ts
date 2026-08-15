import 'reflect-metadata';
import { BadRequestException, ForbiddenException, GoneException, NotFoundException } from '@nestjs/common';

jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }), { virtual: true });

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { FileService, RangeNotSatisfiableException } from './file.service';
import { ThumbnailService } from './thumbnail.service';
import { TelegramStreamPathError } from '../telegram/telegram.errors';
import { FileAccessType } from '../common/entities/file.entity';
import { UserRole } from '../common/entities/user.entity';

const fileId = 'a58f374f-1b14-40f6-a3a8-617d1e5b0e90';
const uploaderId = '1ad590a3-88c4-4742-a1cb-8a0375480e87';

const readyVideo = {
  id: fileId,
  originalName: 'demo.mp4',
  mimeType: 'video/mp4',
  size: 1000,
  uploaderId,
  accessType: FileAccessType.PRIVATE,
  isDeleted: false,
  password: null,
  maxAccessCount: -1,
  expiresIn: null,
  expiresStartAt: null,
  status: 'ready',
  thumbnailPath: null,
};

const ownerUser = { id: uploaderId, role: UserRole.USER };

function createService(overrides: Record<string, unknown> = {}) {
  const service = Object.create(FileService.prototype) as FileService;
  const fileCacheService = { getCachedPath: jest.fn().mockReturnValue(null) };
  const thumbnailDir = (overrides.thumbnailDir as string) || path.join(os.tmpdir(), 'tgtc-preview-test');
  const thumbnailService = new ThumbnailService(
    (overrides.fileRepository as any) || { findOne: jest.fn() },
    {} as any,
    fileCacheService as any,
    { get: jest.fn().mockReturnValue(thumbnailDir) } as any,
  );
  Object.assign(service, {
    fileRepository: (overrides.fileRepository as any) || { findOne: jest.fn() },
    accessLogRepository: { save: jest.fn().mockResolvedValue({ id: 'log-1' }) },
    fileCacheService,
    thumbnailService,
    logger: { warn: jest.fn(), log: jest.fn(), debug: jest.fn() },
    ...overrides,
  });
  return service;
}

function readAll(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

describe('FileService 冷资源单连接预览策略', () => {
  it('冷资源（无正式缓存）Range 预览返回 null，回退控制器全量单连接', async () => {
    const service = createService({
      fileRepository: { findOne: jest.fn().mockResolvedValue(readyVideo) },
    });
    const result = await (service as any).getPreviewStreamWithRange(fileId, ownerUser, 'bytes=0-999');
    expect(result).toBeNull();
    // 冷资源回退全量预览时不写独立日志（由全量预览路径统一记录）
    expect((service as any).accessLogRepository.save).not.toHaveBeenCalled();
  });

  it('已缓存文件 Range 预览返回本地范围流（206 语义，O(1) 定位）', async () => {
    const service = createService({
      fileRepository: { findOne: jest.fn().mockResolvedValue(readyVideo) },
    });
    (service as any).fileCacheService.getCachedPath = jest.fn().mockReturnValue('/tmp/cache/' + fileId);
    const result = await (service as any).getPreviewStreamWithRange(fileId, ownerUser, 'bytes=100-299');
    expect(result).not.toBeNull();
    expect(result.start).toBe(100);
    expect(result.end).toBe(299);
    expect(result.size).toBe(200);
    expect(result.total).toBe(1000);
    expect(result.stream).toBeInstanceOf(Readable);
    result.stream.on('error', () => {});
    expect((service as any).accessLogRepository.save).toHaveBeenCalled();
  });

  it('合法 suffix Range 支持（bytes=-500 取末尾 500 字节）', async () => {
    const service = createService({
      fileRepository: { findOne: jest.fn().mockResolvedValue(readyVideo) },
    });
    (service as any).fileCacheService.getCachedPath = jest.fn().mockReturnValue('/tmp/cache/' + fileId);
    const result = await (service as any).getPreviewStreamWithRange(fileId, ownerUser, 'bytes=-500');
    expect(result).not.toBeNull();
    expect(result.start).toBe(500);
    expect(result.end).toBe(999);
    expect(result.size).toBe(500);
    expect(result.total).toBe(1000);
    result.stream.on('error', () => {});
  });

  it('非法 Range 头（错误单位）抛 416', async () => {
    const service = createService({
      fileRepository: { findOne: jest.fn().mockResolvedValue(readyVideo) },
    });
    await expect(
      (service as any).getPreviewStreamWithRange(fileId, ownerUser, 'items=0-1'),
    ).rejects.toBeInstanceOf(RangeNotSatisfiableException);
  });

  it('multi-range 抛 416（严格单 Range 语义）', async () => {
    const service = createService({
      fileRepository: { findOne: jest.fn().mockResolvedValue(readyVideo) },
    });
    await expect(
      (service as any).getPreviewStreamWithRange(fileId, ownerUser, 'bytes=0-1,3-4'),
    ).rejects.toBeInstanceOf(RangeNotSatisfiableException);
  });

  it('越界 start 抛 RangeNotSatisfiableException', async () => {
    const service = createService({
      fileRepository: { findOne: jest.fn().mockResolvedValue(readyVideo) },
    });
    await expect(
      (service as any).getPreviewStreamWithRange(fileId, ownerUser, 'bytes=1000-'),
    ).rejects.toBeInstanceOf(RangeNotSatisfiableException);
  });

  it('非所有者访问被拒绝', async () => {
    const service = createService({
      fileRepository: { findOne: jest.fn().mockResolvedValue(readyVideo) },
    });
    await expect(
      (service as any).getPreviewStreamWithRange(
        fileId,
        { id: 'other-user', role: UserRole.USER },
        'bytes=0-99',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('error 状态文件即使已缓存也返回 410 Gone', async () => {
    const service = createService({
      fileRepository: { findOne: jest.fn().mockResolvedValue({ ...readyVideo, status: 'error' }) },
    });
    (service as any).fileCacheService.getCachedPath = jest.fn().mockReturnValue('/tmp/cache/' + fileId);
    await expect(
      (service as any).getPreviewStreamWithRange(fileId, ownerUser, 'bytes=0-99'),
    ).rejects.toBeInstanceOf(GoneException);
  });
});

describe('FileService 缓存状态查询', () => {
  it('未缓存返回三态 cold（兼容 cached:false）', async () => {
    const service = createService({
      fileRepository: { findOne: jest.fn().mockResolvedValue(readyVideo) },
    });
    await expect((service as any).getCacheStatus(fileId, ownerUser)).resolves.toEqual({ status: 'cold', cached: false });
  });

  it('已缓存返回三态 cached（兼容 cached:true）', async () => {
    const service = createService({
      fileRepository: { findOne: jest.fn().mockResolvedValue(readyVideo) },
    });
    (service as any).fileCacheService.getCachedPath = jest.fn().mockReturnValue('/tmp/cache/' + fileId);
    await expect((service as any).getCacheStatus(fileId, ownerUser)).resolves.toEqual({ status: 'cached', cached: true });
  });

  it('非所有者被拒绝', async () => {
    const service = createService({
      fileRepository: { findOne: jest.fn().mockResolvedValue(readyVideo) },
    });
    await expect(
      (service as any).getCacheStatus(fileId, { id: 'other-user', role: UserRole.USER }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('isFileCached 委托缓存路径检查', async () => {
    const service = createService();
    (service as any).fileCacheService.getCachedPath = jest.fn().mockReturnValue('/tmp/cache/' + fileId);
    expect((service as any).isFileCached(fileId)).toBe(true);
    (service as any).fileCacheService.getCachedPath = jest.fn().mockReturnValue(null);
    expect((service as any).isFileCached(fileId)).toBe(false);
  });
});

describe('FileService 高清封面', () => {
  let tmpRoot: string;
  let thumbnailDir: string;
  let service: FileService;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgtc-hd-'));
    thumbnailDir = path.join(tmpRoot, 'thumbnails');
    fs.mkdirSync(thumbnailDir, { recursive: true });
    service = createService({
      thumbnailDir,
      fileRepository: { findOne: jest.fn().mockResolvedValue(readyVideo) },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('非视频文件拒绝高清封面', async () => {
    (service as any).fileRepository.findOne = jest
      .fn()
      .mockResolvedValue({ ...readyVideo, mimeType: 'image/png' });
    await expect((service as any).getHdThumbnailStream(fileId, ownerUser)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('读取已生成的高清封面且不重复生成', async () => {
    fs.writeFileSync(path.join(thumbnailDir, `${fileId}.video.hd.webp`), Buffer.from('hd-cover'));
    const buildSpy = jest.spyOn((service as any).thumbnailService, 'buildHdVideoCover');
    const result = await (service as any).getHdThumbnailStream(fileId, ownerUser);
    expect(result.contentType).toBe('image/webp');
    await expect(readAll(result.stream)).resolves.toEqual(Buffer.from('hd-cover'));
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it('高清缺失且无本地缓存时回退标准封面', async () => {
    fs.writeFileSync(path.join(thumbnailDir, `${fileId}.webp`), Buffer.from('std-cover'));
    (service as any).fileRepository.findOne = jest
      .fn()
      .mockResolvedValue({ ...readyVideo, thumbnailPath: `${fileId}.webp` });
    const result = await (service as any).getHdThumbnailStream(fileId, ownerUser);
    await expect(readAll(result.stream)).resolves.toEqual(Buffer.from('std-cover'));
  });

  it('完全无封面时抛 NotFound', async () => {
    await expect((service as any).getHdThumbnailStream(fileId, ownerUser)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('高清缺失但有本地缓存时从缓存生成（仅一次 FFmpeg 抽取）', async () => {
    const extractSpy = jest.fn().mockResolvedValue(undefined);
    (service as any).thumbnailService.extractVideoFrame = extractSpy;
    (service as any).fileCacheService.getCachedPath = jest.fn().mockReturnValue('/tmp/cache/' + fileId);
    await (service as any).thumbnailService.buildHdVideoCover(readyVideo);
    expect(extractSpy).toHaveBeenCalledTimes(1);
    expect(extractSpy).toHaveBeenCalledWith(
      '/tmp/cache/' + fileId,
      expect.stringContaining('hd-cover'),
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('冷资源（无缓存）不生成高清封面', async () => {
    const extractSpy = jest.fn().mockResolvedValue(undefined);
    (service as any).thumbnailService.extractVideoFrame = extractSpy;
    await (service as any).thumbnailService.buildHdVideoCover(readyVideo);
    expect(extractSpy).not.toHaveBeenCalled();
  });

  it('分享链路高清封面读取（不做用户权限断言）', async () => {
    fs.writeFileSync(path.join(thumbnailDir, `${fileId}.video.hd.webp`), Buffer.from('hd-share'));
    const result = await (service as any).getExistingHdMediaThumbnailStream(fileId);
    expect(result.contentType).toBe('image/webp');
    await expect(readAll(result.stream)).resolves.toEqual(Buffer.from('hd-share'));
  });
});

describe('ThumbnailService R6 路径失效可恢复', () => {
  function createThumbnailService(telegram: Record<string, unknown>) {
    const service = Object.create(ThumbnailService.prototype) as ThumbnailService;
    Object.assign(service, {
      telegramService: telegram,
      thumbnailDir: path.join(os.tmpdir(), 'tgtc-thumb-rec-test'),
      fileRepository: { save: jest.fn() },
      fileCacheService: { getCachedPath: jest.fn().mockReturnValue(null) },
      logger: { warn: jest.fn(), log: jest.fn() },
    });
    return service;
  }

  const imageFile = { ...readyVideo, mimeType: 'image/png', telegramFileId: 'fileid-1' };

  it('首次 getFileStream 抛 TelegramStreamPathError 时单次重试回源并成功', async () => {
    const okStream = new Readable({ read() { this.push(null); } });
    const getFileStream = jest
      .fn()
      .mockRejectedValueOnce(new TelegramStreamPathError('path invalid'))
      .mockResolvedValueOnce({ stream: okStream, info: { file_path: '/root/cb/new.png' } });
    const service = createThumbnailService({ getFileStream });

    const result = await (service as any).fetchRemoteSource(imageFile);
    expect(result).toBe(okStream);
    expect(getFileStream).toHaveBeenCalledTimes(2);
  });

  it('重试仍失败时向上抛出（不标记 error），由调用方按原逻辑降级', async () => {
    const getFileStream = jest
      .fn()
      .mockRejectedValueOnce(new TelegramStreamPathError('path invalid'))
      .mockRejectedValueOnce(new TelegramStreamPathError('still invalid'));
    const service = createThumbnailService({ getFileStream });

    await expect((service as any).fetchRemoteSource(imageFile)).rejects.toBeInstanceOf(TelegramStreamPathError);
    expect(getFileStream).toHaveBeenCalledTimes(2);
  });

  it('非路径失效错误不触发重试，原样抛出', async () => {
    const getFileStream = jest.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    const service = createThumbnailService({ getFileStream });

    await expect((service as any).fetchRemoteSource(imageFile)).rejects.toThrow('ETIMEDOUT');
    expect(getFileStream).toHaveBeenCalledTimes(1);
  });
});
