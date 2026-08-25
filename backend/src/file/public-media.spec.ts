import 'reflect-metadata';
import { BadRequestException, ForbiddenException, GoneException } from '@nestjs/common';
import { PassThrough } from 'stream';

jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }), { virtual: true });

import { FileService } from './file.service';
import { FileAccessType } from '../common/entities/file.entity';
import { TelegramFileNotFoundError } from '../telegram/telegram.errors';
import { isSafePublicInlineContentType } from '../common/utils/preview-content-type';

function createService(file: Record<string, unknown>) {
  const service = Object.create(FileService.prototype) as FileService;
  Object.assign(service, {
    fileRepository: { findOne: jest.fn().mockResolvedValue(file) },
    fileCacheService: {
      getCachedPath: jest.fn().mockReturnValue(null),
      isNoCacheMode: jest.fn().mockReturnValue(false),
      getOrCacheRangeStream: jest.fn().mockResolvedValue(null),
    },
  });
  return service;
}

const publicImage = {
  id: 'a58f374f-1b14-40f6-a3a8-617d1e5b0e90',
  originalName: 'photo.png',
  mimeType: 'image/png',
  size: 128,
  uploaderId: '1ad590a3-88c4-4742-a1cb-8a0375480e87',
  accessType: FileAccessType.PUBLIC,
  isDeleted: false,
  password: null,
  maxAccessCount: -1,
  expiresIn: null,
  expiresStartAt: null,
  status: 'ready',
};

describe('FileService public media validation', () => {
  it('accepts an unrestricted public image', async () => {
    const service = createService(publicImage);
    await expect((service as any).getPublicMediaFile(publicImage.id)).resolves.toEqual(publicImage);
  });

  it('rejects non-media files', async () => {
    const service = createService({ ...publicImage, mimeType: 'application/pdf' });
    await expect((service as any).getPublicMediaFile(publicImage.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    'image/svg+xml',
    'image/svg',
    'text/html',
    'application/xhtml+xml',
    'application/xml',
    'text/xml',
    'application/x-javascript',
    'text/javascript',
  ])('rejects dangerous inline MIME: %s（C-01 持久型 XSS 阻断）', async (mime) => {
    const service = createService({ ...publicImage, mimeType: mime });
    await expect((service as any).getPublicMediaFile(publicImage.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects fake-MIME SVG（声明 image/png 但魔数为脚本型，通过扩展名一致性兜底）', () => {
    // 模拟 magic bytes 探测结果为 svg，与声明 image/png 不一致 → 不允许 inline
    expect(isSafePublicInlineContentType('image/png', 'svg')).toBe(false);
  });

  it('accepts consistent bitmap and audio/video MIME', () => {
    expect(isSafePublicInlineContentType('image/png')).toBe(true);
    expect(isSafePublicInlineContentType('image/jpeg', 'jpg')).toBe(true);
    expect(isSafePublicInlineContentType('video/mp4', 'mp4')).toBe(true);
    expect(isSafePublicInlineContentType('audio/mpeg', 'mp3')).toBe(true);
    expect(isSafePublicInlineContentType('image/gif', 'svg')).toBe(false);
  });

  it('rejects private or constrained media files', async () => {
    const privateService = createService({ ...publicImage, accessType: FileAccessType.PRIVATE });
    await expect((privateService as any).getPublicMediaFile(publicImage.id)).rejects.toBeInstanceOf(ForbiddenException);

    const protectedService = createService({ ...publicImage, maxAccessCount: 10 });
    await expect((protectedService as any).getPublicMediaFile(publicImage.id)).rejects.toBeInstanceOf(ForbiddenException);

    const expiringService = createService({ ...publicImage, expiresIn: 24, expiresStartAt: null });
    await expect((expiringService as any).getPublicMediaFile(publicImage.id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects error-status media files with 410 Gone', async () => {
    const service = createService({ ...publicImage, status: 'error' });
    await expect((service as any).getPublicMediaFile(publicImage.id)).rejects.toBeInstanceOf(GoneException);
  });

  it('rejects error-status media files with 410 Gone even when a local cache copy exists', async () => {
    const service = createService({ ...publicImage, status: 'error' });
    (service as any).fileCacheService.getCachedPath = jest.fn().mockReturnValue('/tmp/Cache/a58f374f-1b14');
    await expect((service as any).getPublicMediaFile(publicImage.id)).rejects.toBeInstanceOf(GoneException);
  });
});

describe('FileService getDownloadStream error guard', () => {
  function createStreamService() {
    const service = Object.create(FileService.prototype) as FileService;
    Object.assign(service, {
      fileCacheService: {
        getCachedPath: jest.fn().mockReturnValue(null),
        isNoCacheMode: jest.fn().mockReturnValue(false),
        getOrCacheStream: jest.fn(),
        getNoCacheStream: jest.fn(),
        invalidate: jest.fn(),
      },
      telegramService: {
        getRealtimeFileStream: jest.fn(),
      },
    });
    return service;
  }

  it('rejects error-status files with 410 Gone without touching telegram or cache', async () => {
    const service = createStreamService();
    const errorFile = { ...publicImage, status: 'error' };
    await expect((service as any).getDownloadStream(errorFile)).rejects.toBeInstanceOf(GoneException);
    expect((service as any).telegramService.getRealtimeFileStream).not.toHaveBeenCalled();
    expect((service as any).fileCacheService.getOrCacheStream).not.toHaveBeenCalled();
    expect((service as any).fileCacheService.getNoCacheStream).not.toHaveBeenCalled();
  });

  it('rejects error-status files with 410 Gone even when a local cache copy exists', async () => {
    const service = createStreamService();
    (service as any).fileCacheService.getCachedPath = jest.fn().mockReturnValue('/tmp/Cache/a58f374f-1b14');
    const errorFile = { ...publicImage, status: 'error' };
    await expect((service as any).getDownloadStream(errorFile)).rejects.toBeInstanceOf(GoneException);
    expect((service as any).telegramService.getRealtimeFileStream).not.toHaveBeenCalled();
  });

  it('rejects processing files when no local cache copy exists', async () => {
    const service = createStreamService();
    const processingFile = { ...publicImage, status: 'processing' };
    await expect((service as any).getDownloadStream(processingFile)).rejects.toBeInstanceOf(BadRequestException);
    expect((service as any).telegramService.getRealtimeFileStream).not.toHaveBeenCalled();
  });

  it('allows ready files into the cache/telegram pipeline', async () => {
    const service = createStreamService();
    const stream = new (require('stream').Readable)();
    (service as any).fileCacheService.getOrCacheStream = jest
      .fn()
      .mockResolvedValue({ stream, actualSize: publicImage.size });
    await expect((service as any).getDownloadStream(publicImage)).resolves.toEqual({
      stream,
      actualSize: publicImage.size,
    });
    expect((service as any).fileCacheService.getOrCacheStream).toHaveBeenCalled();
    expect((service as any).telegramService.getRealtimeFileStream).not.toHaveBeenCalled();
  });

  it('marks a file as error when Telegram reports a permanent file-not-found', async () => {
    const service = createStreamService();
    Object.assign(service, {
      fileRepository: {
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      },
      invalidMarkedAt: new Map(),
      auditService: { log: jest.fn() },
      logger: { warn: jest.fn() },
    });
    (service as any).fileCacheService.getOrCacheStream = jest
      .fn()
      .mockRejectedValue(new TelegramFileNotFoundError('invalid file_id'));

    await expect((service as any).getDownloadStream(publicImage)).rejects.toBeInstanceOf(TelegramFileNotFoundError);

    expect((service as any).fileRepository.update).toHaveBeenCalledWith(
      { id: publicImage.id, status: 'ready' },
      expect.objectContaining({ status: 'error', uploadStage: 'failed' }),
    );
    expect((service as any).auditService.log).toHaveBeenCalled();
  });

  it('does not mark error for transient failures (timeout/5xx)', async () => {
    const service = createStreamService();
    Object.assign(service, {
      fileRepository: { update: jest.fn() },
      invalidMarkedAt: new Map(),
      auditService: { log: jest.fn() },
      logger: { warn: jest.fn() },
    });
    (service as any).fileCacheService.getOrCacheStream = jest
      .fn()
      .mockRejectedValue(new Error('ETIMEDOUT'));

    await expect((service as any).getDownloadStream(publicImage)).rejects.toThrow('ETIMEDOUT');
    expect((service as any).fileRepository.update).not.toHaveBeenCalled();
    expect((service as any).auditService.log).not.toHaveBeenCalled();
  });

  it('deduplicates error marking within 5 minutes to avoid audit storms', async () => {
    const service = createStreamService();
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    Object.assign(service, {
      fileRepository: { update },
      invalidMarkedAt: new Map([[publicImage.id, Date.now()]]),
      auditService: { log: jest.fn() },
      logger: { warn: jest.fn() },
    });
    (service as any).fileCacheService.getOrCacheStream = jest
      .fn()
      .mockRejectedValue(new TelegramFileNotFoundError('invalid file_id'));

    await expect((service as any).getDownloadStream(publicImage)).rejects.toBeInstanceOf(TelegramFileNotFoundError);
    expect(update).not.toHaveBeenCalled();
  });

  it('attaches an error handler to the stream for spool-path permanent failures', async () => {
    const service = createStreamService();
    Object.assign(service, {
      fileRepository: { update: jest.fn().mockResolvedValue({ affected: 1 }) },
      invalidMarkedAt: new Map(),
      auditService: { log: jest.fn() },
      logger: { warn: jest.fn() },
    });
    const stream = new (require('stream').Readable)();
    (service as any).fileCacheService.getOrCacheStream = jest
      .fn()
      .mockResolvedValue({ stream, fromCache: false });

    const result = await (service as any).getDownloadStream(publicImage);
    // 触发上游构建失败 → stream error 事件携带 TelegramFileNotFoundError
    result.stream.emit('error', new TelegramFileNotFoundError('file not found'));
    await new Promise((resolve) => setImmediate(resolve));

    expect((service as any).fileRepository.update).toHaveBeenCalled();
  });
});

describe('FileService public media cold-range policy', () => {
  it('returns null for cold public media Range (fallback to full single connection)', async () => {
    const service = createService(publicImage);
    (service as any).fileCacheService.getOrCacheRangeStream = jest.fn().mockResolvedValue(new PassThrough());
    await expect(
      (service as any).getPublicMediaStreamWithRange(publicImage.id, 'bytes=0-99'),
    ).resolves.toMatchObject({ start: 0, end: 99, total: 128 });
  });

  it('serves a range stream from the local cache for public media', async () => {
    const service = createService(publicImage);
    (service as any).fileCacheService.getOrCacheRangeStream = jest.fn().mockResolvedValue(new PassThrough());
    (service as any).fileCacheService.getCachedPath = jest.fn().mockReturnValue('/tmp/Cache/a58f374f-1b14');
    const result = await (service as any).getPublicMediaStreamWithRange(publicImage.id, 'bytes=0-9');
    expect(result).not.toBeNull();
    expect(result.start).toBe(0);
    expect(result.end).toBe(9);
    result.stream.on('error', () => {});
  });
});

describe('FileService R4 恢复成功路径回写', () => {
  function createRecoveryService(overrides: Record<string, unknown> = {}) {
    const service = Object.create(FileService.prototype) as FileService;
    Object.assign(service, {
      fileCacheService: {
        getCachedPath: jest.fn().mockReturnValue(null),
        isNoCacheMode: jest.fn().mockReturnValue(false),
        getOrCacheStream: jest.fn(),
        getNoCacheStream: jest.fn(),
        invalidate: jest.fn(),
      },
      telegramService: {
        getRealtimeFileStream: jest.fn(),
      },
      fileRepository: { update: jest.fn().mockResolvedValue({ affected: 1 }) },
      invalidMarkedAt: new Map(),
      auditService: { log: jest.fn() },
      logger: { warn: jest.fn(), log: jest.fn() },
      ...overrides,
    });
    return service;
  }

  const staleFile = {
    ...publicImage,
    status: 'ready',
    telegramFilePath: '/data/cb/old/path.png',
    telegramFileId: 'fileid-1',
    uploadVersion: 2,
  };

  it('恢复成功且路径变化时条件回写 telegramFilePath（含 uploadVersion 守卫）', async () => {
    const service = createRecoveryService();
    const stream = new (require('stream').Readable)();
    // fetchFn 捕获回源后的 info
    (service as any).fileCacheService.getOrCacheStream = jest.fn().mockImplementation(async (_id, _size, fetchFn) => {
      await fetchFn();
      return { stream, fromCache: false };
    });
    (service as any).telegramService.getRealtimeFileStream = jest.fn().mockResolvedValue({
      stream,
      info: { file_id: 'fileid-1', file_path: '/root/cb/new/path.png', file_size: publicImage.size },
    });

    await (service as any).getDownloadStream(staleFile);

    expect((service as any).fileRepository.update).toHaveBeenCalledWith(
      { id: publicImage.id, status: 'ready', uploadVersion: 2 },
      { telegramFilePath: '/root/cb/new/path.png' },
    );
  });

  it('路径未变化时不触发数据库写入', async () => {
    const service = createRecoveryService();
    const stream = new (require('stream').Readable)();
    (service as any).fileCacheService.getOrCacheStream = jest.fn().mockImplementation(async (_id, _size, fetchFn) => {
      await fetchFn();
      return { stream, fromCache: false };
    });
    (service as any).telegramService.getRealtimeFileStream = jest.fn().mockResolvedValue({
      stream,
      info: { file_id: 'fileid-1', file_path: '/data/cb/old/path.png', file_size: publicImage.size },
    });

    await (service as any).getDownloadStream(staleFile);

    expect((service as any).fileRepository.update).not.toHaveBeenCalled();
  });

  it('缓存命中（fetchFn 未触发回源）时不回写', async () => {
    const service = createRecoveryService();
    const stream = new (require('stream').Readable)();
    // 命中缓存：fetchFn 不会被调用
    (service as any).fileCacheService.getOrCacheStream = jest.fn().mockResolvedValue({ stream, fromCache: true });
    (service as any).fileCacheService.getCachedPath = jest.fn().mockReturnValue('/tmp/cache/' + publicImage.id);

    await (service as any).getDownloadStream(staleFile);

    expect((service as any).telegramService.getRealtimeFileStream).not.toHaveBeenCalled();
    expect((service as any).fileRepository.update).not.toHaveBeenCalled();
  });

  it('回写失败不阻断主流程', async () => {
    const service = createRecoveryService({
      fileRepository: { update: jest.fn().mockRejectedValue(new Error('db down')) },
    });
    const stream = new (require('stream').Readable)();
    (service as any).fileCacheService.getOrCacheStream = jest.fn().mockImplementation(async (_id, _size, fetchFn) => {
      await fetchFn();
      return { stream, fromCache: false };
    });
    (service as any).telegramService.getRealtimeFileStream = jest.fn().mockResolvedValue({
      stream,
      info: { file_id: 'fileid-1', file_path: '/root/cb/new/path.png', file_size: publicImage.size },
    });

    await expect((service as any).getDownloadStream(staleFile)).resolves.toEqual({ stream, actualSize: publicImage.size });
    expect((service as any).logger.warn).toHaveBeenCalled();
  });
});

describe('FileService R5 已 error 文件全入口 410', () => {
  it('getPublicMediaStream 对已 error 文件抛 GoneException', async () => {
    const service = Object.create(FileService.prototype) as FileService;
    Object.assign(service, {
      fileRepository: { findOne: jest.fn().mockResolvedValue({ ...publicImage, status: 'error' }) },
      fileCacheService: { getCachedPath: jest.fn().mockReturnValue(null) },
      logger: { warn: jest.fn() },
    });
    await expect((service as any).getPublicMediaStream(publicImage.id)).rejects.toBeInstanceOf(GoneException);
  });

  it('getPreviewStream 对已 error 文件抛 GoneException', async () => {
    const service = Object.create(FileService.prototype) as FileService;
    Object.assign(service, {
      fileRepository: { findOne: jest.fn().mockResolvedValue({ ...publicImage, status: 'error' }) },
      fileCacheService: { getCachedPath: jest.fn().mockReturnValue(null) },
      logger: { warn: jest.fn() },
    });
    const owner = { id: publicImage.uploaderId, role: 'user' };
    await expect((service as any).getPreviewStream(publicImage.id, owner)).rejects.toBeInstanceOf(GoneException);
  });

  it('getStreamForShareDownload 对已 error 文件抛 GoneException', async () => {
    const service = Object.create(FileService.prototype) as FileService;
    Object.assign(service, {
      fileRepository: { findOne: jest.fn().mockResolvedValue({ ...publicImage, status: 'error' }) },
      fileCacheService: { getCachedPath: jest.fn().mockReturnValue(null) },
      logger: { warn: jest.fn() },
    });
    await expect((service as any).getStreamForShareDownload(publicImage.id)).rejects.toBeInstanceOf(GoneException);
  });

  it('getPreviewStreamWithRange 对已 error 文件抛 GoneException', async () => {
    const service = Object.create(FileService.prototype) as FileService;
    Object.assign(service, {
      fileRepository: { findOne: jest.fn().mockResolvedValue({ ...publicImage, status: 'error' }) },
      fileCacheService: { getCachedPath: jest.fn().mockReturnValue('/tmp/cache/' + publicImage.id) },
      logger: { warn: jest.fn() },
    });
    const owner = { id: publicImage.uploaderId, role: 'user' };
    await expect(
      (service as any).getPreviewStreamWithRange(publicImage.id, owner, 'bytes=0-9'),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it('getSharePreviewStreamWithRange 对已 error 文件抛 GoneException', async () => {
    const service = Object.create(FileService.prototype) as FileService;
    Object.assign(service, {
      fileRepository: { findOne: jest.fn().mockResolvedValue({ ...publicImage, status: 'error' }) },
      fileCacheService: { getCachedPath: jest.fn().mockReturnValue('/tmp/cache/' + publicImage.id) },
      logger: { warn: jest.fn() },
    });
    await expect(
      (service as any).getSharePreviewStreamWithRange(publicImage.id, 'bytes=0-9'),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it('getExistingMediaThumbnailStream 对已 error 文件抛 GoneException', async () => {
    const service = Object.create(FileService.prototype) as FileService;
    Object.assign(service, {
      fileRepository: { findOne: jest.fn().mockResolvedValue({ ...publicImage, status: 'error' }) },
      fileCacheService: { getCachedPath: jest.fn().mockReturnValue(null) },
      logger: { warn: jest.fn() },
    });
    await expect((service as any).getExistingMediaThumbnailStream(publicImage.id)).rejects.toBeInstanceOf(GoneException);
  });
});
