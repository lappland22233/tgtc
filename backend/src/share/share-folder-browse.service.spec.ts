import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ShareFolderBrowseService, computeShareExpiry } from './share-folder-browse.service';
import { ShareLinkStatus, ShareTargetType } from '../common/entities/share-link.entity';

/** 构造分享链接实体（mock），类型放宽避免强约束构造测试夹具 */
function makeLink(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'share-id-1',
    token: 'tok123',
    targetType: ShareTargetType.FOLDER,
    targetId: 'folder-root',
    creatorId: 'user-1',
    password: null,
    maxAccessCount: -1,
    currentAccessCount: 0,
    expiresIn: null,
    expiresStartAt: null,
    isDeleted: false,
    status: ShareLinkStatus.ACTIVE,
    ...overrides,
  };
}

function makeService(overrides: Record<string, unknown> = {}) {
  const service = Object.create(ShareFolderBrowseService.prototype) as any;
  service.fileRepo = { findOne: jest.fn(), find: jest.fn(), count: jest.fn().mockResolvedValue(0) };
  service.folderRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
    findAncestors: jest.fn(),
    manager: { query: jest.fn() },
  };
  service.audit = { log: jest.fn() };
  Object.assign(service, overrides);
  return service as ShareFolderBrowseService;
}

describe('ShareFolderBrowseService', () => {
  describe('assertFileInShare', () => {
    it('文件分享：fileId 必须等于 targetId', async () => {
      const service = makeService();
      const link = makeLink({ targetType: ShareTargetType.FILE, targetId: 'file-1' });
      await expect(service.assertFileInShare(link, 'file-1')).resolves.toBeUndefined();
      await expect(service.assertFileInShare(link, 'file-2')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('文件夹分享：文件位于根目录时拒绝', async () => {
      const service = makeService();
      (service as any).fileRepo.findOne.mockResolvedValue({ id: 'f1', folderId: null });
      await expect(service.assertFileInShare(makeLink(), 'f1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('文件夹分享：文件在子树内通过，不在子树内拒绝', async () => {
      const service = makeService();
      (service as any).fileRepo.findOne.mockResolvedValue({ id: 'f1', folderId: 'folder-child' });
      (service as any).folderRepo.manager.query.mockResolvedValueOnce([{ 1: 1 }]).mockResolvedValueOnce([]);
      await expect(service.assertFileInShare(makeLink(), 'f1')).resolves.toBeUndefined();
      await expect(service.assertFileInShare(makeLink(), 'f1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('isFolderInSubtree', () => {
    it('闭包表命中返回 true，未命中返回 false', async () => {
      const service = makeService();
      (service as any).folderRepo.manager.query.mockResolvedValueOnce([{ 1: 1 }]).mockResolvedValueOnce([]);
      await expect(service.isFolderInSubtree('a', 'b')).resolves.toBe(true);
      await expect(service.isFolderInSubtree('a', 'b')).resolves.toBe(false);
    });
  });

  describe('listFolderContentsForShare', () => {
    it('folderId 不在子树内抛 Forbidden', async () => {
      const service = makeService();
      (service as any).folderRepo.manager.query.mockResolvedValue([]);
      await expect(service.listFolderContentsForShare(makeLink(), 'other')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('文件夹不存在抛 NotFound', async () => {
      const service = makeService();
      (service as any).folderRepo.manager.query.mockResolvedValue([{ 1: 1 }]);
      (service as any).folderRepo.findOne.mockResolvedValue(null);
      await expect(service.listFolderContentsForShare(makeLink(), 'folder-root')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('返回子文件夹与文件，并记录审计', async () => {
      const service = makeService();
      (service as any).folderRepo.manager.query.mockResolvedValue([{ 1: 1 }]);
      (service as any).folderRepo.findOne.mockResolvedValue({ id: 'folder-root', isDeleted: false });
      (service as any).folderRepo.find.mockResolvedValueOnce([{ id: 'sub-1', name: '子目录', createdAt: new Date(), parentId: 'folder-root' }]);
      (service as any).fileRepo.find.mockResolvedValueOnce([
        { id: 'file-1', originalName: 'a.mp4', mimeType: 'video/mp4', size: 100, createdAt: new Date(), uploadVersion: 3, status: 'ready' },
      ]);
      (service as any).fileRepo.count.mockResolvedValue(1);
      const result = await service.listFolderContentsForShare(makeLink(), 'folder-root');
      expect(result.subfolders).toHaveLength(1);
      expect(result.files[0].uploadVersion).toBe(3);
      expect(result.files[0].status).toBe('ready');
      expect(result.files[0].downloadUrl).toBe('/api/s/tok123/download/file-1');
      // G5-13：分页元数据
      expect(result.pagination).toEqual({ page: 1, limit: 100, total: 1, hasMore: false });
      expect((service as any).fileRepo.count).toHaveBeenCalledWith({ where: { folderId: 'folder-root', isDeleted: false } });
      expect((service as any).audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'share_link_access' }));
    });
  });

  describe('getFolderBreadcrumbForShare', () => {
    it('folderId 等于 target 返回根自身', async () => {
      const service = makeService();
      (service as any).folderRepo.findOne.mockResolvedValue({ id: 'folder-root', name: '根' });
      const result = await service.getFolderBreadcrumbForShare(makeLink(), 'folder-root');
      expect(result).toEqual([{ id: 'folder-root', name: '根' }]);
    });

    it('子文件夹返回从根到自身的路径，过滤软删祖先', async () => {
      const service = makeService();
      (service as any).folderRepo.manager.query.mockResolvedValue([{ 1: 1 }]);
      (service as any).folderRepo.findOne.mockResolvedValue({ id: 'folder-child' });
      (service as any).folderRepo.findAncestors.mockResolvedValue([
        { id: 'folder-child', name: '子', isDeleted: false },
        { id: 'deleted-folder', name: '已删', isDeleted: true },
        { id: 'folder-root', name: '根', isDeleted: false },
      ]);
      const result = await service.getFolderBreadcrumbForShare(makeLink(), 'folder-child');
      expect(result).toEqual([
        { id: 'folder-root', name: '根' },
        { id: 'folder-child', name: '子' },
      ]);
    });

    it('裁剪分享根之上的祖先，不泄漏分享范围外目录', async () => {
      const service = makeService();
      // 分享根是 folder-root，其上层还有 outer-ancestor 与 global-root
      (service as any).folderRepo.manager.query.mockResolvedValue([{ 1: 1 }]);
      (service as any).folderRepo.findOne.mockResolvedValue({ id: 'folder-child' });
      (service as any).folderRepo.findAncestors.mockResolvedValue([
        { id: 'folder-child', name: '子', isDeleted: false },
        { id: 'folder-root', name: '根', isDeleted: false },
        { id: 'outer-ancestor', name: '外祖先', isDeleted: false },
        { id: 'global-root', name: '全局根', isDeleted: false },
      ]);
      const result = await service.getFolderBreadcrumbForShare(makeLink(), 'folder-child');
      // 必须从 folder-root 开始，绝不包含 outer-ancestor / global-root
      expect(result).toEqual([
        { id: 'folder-root', name: '根' },
        { id: 'folder-child', name: '子' },
      ]);
      expect(result.map((r) => r.id)).not.toContain('outer-ancestor');
      expect(result.map((r) => r.id)).not.toContain('global-root');
    });
  });

  describe('computeShareExpiry', () => {
    it('无有效期返回 null', () => {
      expect(computeShareExpiry(makeLink())).toBeNull();
    });
    it('按 expiresIn 小时计算过期时间', () => {
      const start = new Date('2026-08-13T00:00:00.000Z');
      const link = makeLink({ expiresIn: 24, expiresStartAt: start }) as Parameters<typeof computeShareExpiry>[0];
      expect(computeShareExpiry(link)).toBe('2026-08-14T00:00:00.000Z');
    });
  });
});
