import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }), { virtual: true });

import { FileService } from './file.service';
import { FileAccessType } from '../common/entities/file.entity';
import { isSafePublicInlineContentType } from '../common/utils/preview-content-type';

function createService(file: Record<string, unknown>) {
  const service = Object.create(FileService.prototype) as FileService;
  Object.assign(service, {
    fileRepository: { findOne: jest.fn().mockResolvedValue(file) },
    fileCacheService: { getCachedPath: jest.fn().mockReturnValue(null) },
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

  it('rejects error-status media files', async () => {
    const service = createService({ ...publicImage, status: 'error' });
    await expect((service as any).getPublicMediaFile(publicImage.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects error-status media files even when a local cache copy exists', async () => {
    const service = createService({ ...publicImage, status: 'error' });
    (service as any).fileCacheService.getCachedPath = jest.fn().mockReturnValue('/tmp/Cache/a58f374f-1b14');
    await expect((service as any).getPublicMediaFile(publicImage.id)).rejects.toBeInstanceOf(BadRequestException);
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
      },
      telegramService: {
        getRealtimeFileStream: jest.fn(),
      },
    });
    return service;
  }

  it('rejects error-status files without touching telegram or cache', async () => {
    const service = createStreamService();
    const errorFile = { ...publicImage, status: 'error' };
    await expect((service as any).getDownloadStream(errorFile)).rejects.toBeInstanceOf(BadRequestException);
    expect((service as any).telegramService.getRealtimeFileStream).not.toHaveBeenCalled();
    expect((service as any).fileCacheService.getOrCacheStream).not.toHaveBeenCalled();
    expect((service as any).fileCacheService.getNoCacheStream).not.toHaveBeenCalled();
  });

  it('rejects error-status files even when a local cache copy exists', async () => {
    const service = createStreamService();
    (service as any).fileCacheService.getCachedPath = jest.fn().mockReturnValue('/tmp/Cache/a58f374f-1b14');
    const errorFile = { ...publicImage, status: 'error' };
    await expect((service as any).getDownloadStream(errorFile)).rejects.toBeInstanceOf(BadRequestException);
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
    (service as any).fileCacheService.getOrCacheStream = jest
      .fn()
      .mockResolvedValue({ stream: {}, actualSize: publicImage.size });
    await expect((service as any).getDownloadStream(publicImage)).resolves.toEqual({
      stream: {},
      actualSize: publicImage.size,
    });
    expect((service as any).fileCacheService.getOrCacheStream).toHaveBeenCalled();
    expect((service as any).telegramService.getRealtimeFileStream).not.toHaveBeenCalled();
  });
});

describe('FileService public media cold-range policy', () => {
  it('returns null for cold public media Range (fallback to full single connection)', async () => {
    const service = createService(publicImage);
    await expect(
      (service as any).getPublicMediaStreamWithRange(publicImage.id, 'bytes=0-99'),
    ).resolves.toBeNull();
  });

  it('serves a range stream from the local cache for public media', async () => {
    const service = createService(publicImage);
    (service as any).fileCacheService.getCachedPath = jest.fn().mockReturnValue('/tmp/Cache/a58f374f-1b14');
    const result = await (service as any).getPublicMediaStreamWithRange(publicImage.id, 'bytes=0-9');
    expect(result).not.toBeNull();
    expect(result.start).toBe(0);
    expect(result.end).toBe(9);
    result.stream.on('error', () => {});
  });
});
