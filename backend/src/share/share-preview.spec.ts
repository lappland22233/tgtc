import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
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

function makeService() {
  const service = Object.create(ShareService.prototype) as ShareService;
  Object.assign(service, {
    shareLinkRepo: { findOne: jest.fn() },
    fileRepo: { findOne: jest.fn() },
    folderRepo: { manager: { query: jest.fn() } },
    audit: { log: jest.fn() },
    passwordService: { verifyAccessJwt: jest.fn() },
    fileService: {
      getSharePreviewStreamWithRange: jest.fn(),
      getStreamForShareDownload: jest.fn(),
    },
    configService: { get: jest.fn() },
    previewSessions: new Map<string, number>(),
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

describe('ShareService 预览访问计数（逻辑访问会话去重）', () => {
  it('maxAccessCount=1：冷资源 Range 回退 + 重复预览只消费一次额度', async () => {
    const service = makeService();
    (service as any).shareLinkRepo.findOne.mockResolvedValue(makeLink());
    (service as any).assertShareUsable = jest.fn().mockResolvedValue(undefined);
    (service as any).assertFileInShare = jest.fn().mockResolvedValue(undefined);
    (service as any).consumeShareAccess = jest.fn().mockResolvedValue(undefined);
    // 冷资源：Range 命中返回 null → 回退全量流（浏览器重试场景）
    (service as any).fileService.getSharePreviewStreamWithRange.mockResolvedValue(null);
    stubFullStream(service);

    for (let i = 0; i < 3; i++) {
      const result = await service.getSharePreviewStream('tok123', 'file-id-1', undefined, null, 'bytes=0-99');
      expect(result).toBeDefined();
    }
    expect((service as any).consumeShareAccess).toHaveBeenCalledTimes(1);
  });

  it('窗口内不同文件各自独立计数', async () => {
    const service = makeService();
    (service as any).shareLinkRepo.findOne.mockResolvedValue(
      makeLink({ maxAccessCount: 2, targetType: ShareTargetType.FOLDER, targetId: 'folder-1' }),
    );
    (service as any).assertShareUsable = jest.fn().mockResolvedValue(undefined);
    (service as any).assertFileInShare = jest.fn().mockResolvedValue(undefined);
    (service as any).consumeShareAccess = jest.fn().mockResolvedValue(undefined);
    (service as any).fileService.getSharePreviewStreamWithRange.mockResolvedValue(null);
    stubFullStream(service);

    await service.getSharePreviewStream('tok123', 'file-a', undefined, null);
    await service.getSharePreviewStream('tok123', 'file-b', undefined, null);
    await service.getSharePreviewStream('tok123', 'file-a', undefined, null);

    expect((service as any).consumeShareAccess).toHaveBeenCalledTimes(2);
  });

  it('窗口过期后再次预览重新计数', async () => {
    const service = makeService();
    (service as any).shareLinkRepo.findOne.mockResolvedValue(makeLink());
    (service as any).assertShareUsable = jest.fn().mockResolvedValue(undefined);
    (service as any).assertFileInShare = jest.fn().mockResolvedValue(undefined);
    (service as any).consumeShareAccess = jest.fn().mockResolvedValue(undefined);
    (service as any).fileService.getSharePreviewStreamWithRange.mockResolvedValue(null);
    stubFullStream(service);

    await service.getSharePreviewStream('tok123', 'file-id-1', undefined, null);
    // 模拟窗口过期
    const map = (service as any).previewSessions as Map<string, number>;
    for (const k of map.keys()) map.set(k, Date.now() - 1);
    await service.getSharePreviewStream('tok123', 'file-id-1', undefined, null);

    expect((service as any).consumeShareAccess).toHaveBeenCalledTimes(2);
  });

  it('有密码分享缺少 access JWT 时拒绝（不消费额度）', async () => {
    const service = makeService();
    (service as any).shareLinkRepo.findOne.mockResolvedValue(makeLink({ password: 'hash' }));
    (service as any).assertShareUsable = jest.fn().mockResolvedValue(undefined);
    (service as any).assertFileInShare = jest.fn().mockResolvedValue(undefined);
    (service as any).consumeShareAccess = jest.fn().mockResolvedValue(undefined);

    await expect(
      service.getSharePreviewStream('tok123', 'file-id-1', undefined, null),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((service as any).consumeShareAccess).not.toHaveBeenCalled();
  });

  it('有密码分享 access JWT 失效时拒绝（不消费额度）', async () => {
    const service = makeService();
    (service as any).shareLinkRepo.findOne.mockResolvedValue(makeLink({ password: 'hash' }));
    (service as any).assertShareUsable = jest.fn().mockResolvedValue(undefined);
    (service as any).assertFileInShare = jest.fn().mockResolvedValue(undefined);
    (service as any).consumeShareAccess = jest.fn().mockResolvedValue(undefined);
    (service as any).passwordService.verifyAccessJwt.mockResolvedValue(false);

    await expect(
      service.getSharePreviewStream('tok123', 'file-id-1', 'bad-jwt', null),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((service as any).consumeShareAccess).not.toHaveBeenCalled();
  });
});
