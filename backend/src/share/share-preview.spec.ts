import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';

jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }), { virtual: true });

import { ShareService } from './share.service';
import { ShareLinkStatus, ShareTargetType } from '../common/entities/share-link.entity';

/** 构造分享链接实体（mock） */
function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'share-id-1',
    token: 'tok123',
    targetType: ShareTargetType.FILE,
    targetId: 'file-id-1',
    creatorId: 'user-1',
    password: null,
    maxAccessCount: 1,
    currentAccessCount: 0,
    expiresIn: null,
    expiresStartAt: null,
    isDeleted: false,
    status: ShareLinkStatus.ACTIVE,
    ...overrides,
  };
}

function makeStream() {
  return new Readable({ read() {} });
}

/** 默认返回 consumed 的预览会话服务 mock */
function makePreviewSessionService() {
  return {
    consumePreviewAccess: jest.fn().mockResolvedValue('consumed'),
    pruneExpired: jest.fn().mockResolvedValue(0),
  };
}

function makeService() {
  const service = Object.create(ShareService.prototype) as ShareService;
  Object.assign(service, {
    shareLinkRepo: {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    },
    fileRepo: { findOne: jest.fn() },
    folderRepo: { manager: { query: jest.fn() } },
    audit: { log: jest.fn() },
    passwordService: { verifyAccessJwt: jest.fn() },
    fileService: {
      getSharePreviewStreamWithRange: jest.fn(),
      getStreamForShareDownload: jest.fn(),
    },
    configService: { get: jest.fn() },
    previewSessionService: makePreviewSessionService(),
    folderBrowse: {
      assertFileInShare: jest.fn().mockResolvedValue(undefined),
      listFolderContentsForShare: jest.fn(),
      getFolderBreadcrumbForShare: jest.fn(),
      getFolderInfoForShare: jest.fn(),
    },
  });
  return service;
}

/** 预置预览流返回 */
function stubFullStream(service: ShareService) {
  (service as any).fileService.getStreamForShareDownload.mockResolvedValue({
    stream: makeStream(),
    contentType: 'video/mp4',
    filename: 'demo.mp4',
    size: 100,
    isInline: true,
  });
}

describe('ShareService 预览访问计数（持久化预览会话）', () => {
  it('分享下载复用 FileService 统一下载链路（包含 Telegram 冷回源自愈）', async () => {
    const service = makeService();
    const link = makeLink();
    const downloadResult = {
      stream: makeStream(),
      contentType: 'application/octet-stream',
      filename: 'demo.bin',
      size: 100,
      isInline: false,
    };
    (service as any).shareLinkRepo.findOne.mockResolvedValue(link);
    (service as any).assertShareUsable = jest.fn().mockResolvedValue(undefined);
    (service as any).consumeShareAccess = jest.fn().mockResolvedValue(undefined);
    (service as any).fileService.getStreamForShareDownload.mockResolvedValue(downloadResult);

    const result = await service.getShareDownloadStream('tok123', 'file-id-1', undefined, null);

    expect(result).toBe(downloadResult);
    expect((service as any).fileService.getStreamForShareDownload).toHaveBeenCalledWith('file-id-1', undefined);
  });

  it('同访客同文件重复预览：会话服务仅首次返回 consumed，后续幂等', async () => {
    const service = makeService();
    (service as any).shareLinkRepo.findOne.mockResolvedValue(makeLink());
    (service as any).assertShareUsable = jest.fn().mockResolvedValue(undefined);
    (service as any).fileService.getSharePreviewStreamWithRange.mockResolvedValue(null);
    stubFullStream(service);

    const consumePreviewAccess = (service as any).previewSessionService.consumePreviewAccess;
    // 模拟数据库唯一约束：首次 consumed，之后 idempotent
    consumePreviewAccess
      .mockResolvedValueOnce('consumed')
      .mockResolvedValue('idempotent');

    for (let i = 0; i < 3; i++) {
      const result = await service.getSharePreviewStream('tok123', 'file-id-1', undefined, null, 'bytes=0-99', 'visitor-hash-a');
      expect(result).toBeDefined();
    }
    // 每次调用都会询问会话服务；扣次是否发生由服务内唯一约束保证
    expect(consumePreviewAccess).toHaveBeenCalledTimes(3);
    expect(consumePreviewAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'share-id-1' }),
      'file-id-1',
      'visitor-hash-a',
    );
  });

  it('不同访客（visitorHash）各自独立计数', async () => {
    const service = makeService();
    (service as any).shareLinkRepo.findOne.mockResolvedValue(makeLink());
    (service as any).assertShareUsable = jest.fn().mockResolvedValue(undefined);
    (service as any).fileService.getSharePreviewStreamWithRange.mockResolvedValue(null);
    stubFullStream(service);

    const consumePreviewAccess = (service as any).previewSessionService.consumePreviewAccess;
    consumePreviewAccess
      .mockResolvedValueOnce('consumed')
      .mockResolvedValueOnce('consumed')
      .mockResolvedValue('idempotent');

    await service.getSharePreviewStream('tok123', 'file-id-1', undefined, null, undefined, 'visitor-a');
    await service.getSharePreviewStream('tok123', 'file-id-1', undefined, null, undefined, 'visitor-b');
    await service.getSharePreviewStream('tok123', 'file-id-1', undefined, null, undefined, 'visitor-a');

    expect(consumePreviewAccess).toHaveBeenNthCalledWith(1, expect.anything(), 'file-id-1', 'visitor-a');
    expect(consumePreviewAccess).toHaveBeenNthCalledWith(2, expect.anything(), 'file-id-1', 'visitor-b');
    expect(consumePreviewAccess).toHaveBeenNthCalledWith(3, expect.anything(), 'file-id-1', 'visitor-a');
  });

  it('额度耗尽时抛 404 且更新分享状态为 EXHAUSTED', async () => {
    const service = makeService();
    (service as any).shareLinkRepo.findOne.mockResolvedValue(makeLink());
    (service as any).assertShareUsable = jest.fn().mockResolvedValue(undefined);
    (service as any).fileService.getSharePreviewStreamWithRange.mockResolvedValue(null);
    stubFullStream(service);

    (service as any).previewSessionService.consumePreviewAccess.mockResolvedValue('exhausted');

    await expect(
      service.getSharePreviewStream('tok123', 'file-id-1', undefined, null, undefined, 'visitor-a'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect((service as any).shareLinkRepo.update).toHaveBeenCalledWith(
      'share-id-1',
      { status: ShareLinkStatus.EXHAUSTED },
    );
  });

  it('有密码分享缺少 access JWT 时拒绝（不询问会话服务）', async () => {
    const service = makeService();
    (service as any).shareLinkRepo.findOne.mockResolvedValue(makeLink({ password: 'hash' }));
    (service as any).assertShareUsable = jest.fn().mockResolvedValue(undefined);

    await expect(
      service.getSharePreviewStream('tok123', 'file-id-1', undefined, null, undefined, 'visitor-a'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((service as any).previewSessionService.consumePreviewAccess).not.toHaveBeenCalled();
  });

  it('有密码分享 access JWT 失效时拒绝（不询问会话服务）', async () => {
    const service = makeService();
    (service as any).shareLinkRepo.findOne.mockResolvedValue(makeLink({ password: 'hash' }));
    (service as any).assertShareUsable = jest.fn().mockResolvedValue(undefined);
    (service as any).passwordService.verifyAccessJwt.mockResolvedValue(false);

    await expect(
      service.getSharePreviewStream('tok123', 'file-id-1', 'bad-jwt', null, undefined, 'visitor-a'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((service as any).previewSessionService.consumePreviewAccess).not.toHaveBeenCalled();
  });
});
