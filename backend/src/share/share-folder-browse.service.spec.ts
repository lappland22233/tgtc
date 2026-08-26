import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ShareFolderBrowseService, computeShareExpiry } from './share-folder-browse.service';
import { ShareLinkStatus, ShareTargetType } from '../common/entities/share-link.entity';

function makeLink(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'share-id-1', token: 'tok123', targetType: ShareTargetType.FOLDER, targetId: 'folder-root',
    creatorId: 'user-1', password: null, maxAccessCount: -1, currentAccessCount: 0,
    expiresIn: null, expiresStartAt: null, isDeleted: false, status: ShareLinkStatus.ACTIVE,
    ...overrides,
  };
}

function folder(id: string, parentId: string | null, overrides: Record<string, unknown> = {}) {
  return { id, name: id, parentId, ownerId: 'user-1', isDeleted: false, createdAt: new Date(), ...overrides };
}

function makeService(overrides: Record<string, unknown> = {}) {
  const service = Object.create(ShareFolderBrowseService.prototype) as any;
  service.fileRepo = { findOne: jest.fn(), find: jest.fn(), count: jest.fn().mockResolvedValue(0) };
  service.folderRepo = { findOne: jest.fn(), find: jest.fn() };
  service.audit = { log: jest.fn() };
  Object.assign(service, overrides);
  return service as ShareFolderBrowseService;
}

function mockFolders(service: ShareFolderBrowseService, folders: Record<string, any>) {
  (service as any).folderRepo.findOne.mockImplementation(({ where }: any) => {
    const value = folders[where.id];
    return Promise.resolve(value && !value.isDeleted ? value : null);
  });
}

describe('ShareFolderBrowseService', () => {
  describe('assertFileInShare', () => {
    it('文件分享：fileId 必须等于 targetId', async () => {
      const service = makeService();
      const link = makeLink({ targetType: ShareTargetType.FILE, targetId: 'file-1' });
      await expect(service.assertFileInShare(link, 'file-1')).resolves.toBeUndefined();
      await expect(service.assertFileInShare(link, 'file-2')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('文件夹分享：仅在同一 owner 的完整 parentId 链到达分享根时允许文件', async () => {
      const service = makeService();
      mockFolders(service, {
        'folder-child': folder('folder-child', 'folder-root'),
        'folder-root': folder('folder-root', null),
      });
      (service as any).fileRepo.findOne.mockResolvedValue({ id: 'f1', folderId: 'folder-child', uploaderId: 'user-1' });
      await expect(service.assertFileInShare(makeLink(), 'f1')).resolves.toBeUndefined();
      expect((service as any).folderRepo.manager).toBeUndefined();
    });

    it.each([
      ['根目录文件', { folderId: null, uploaderId: 'user-1' }, {}],
      ['文件 owner 不匹配', { folderId: 'folder-root', uploaderId: 'user-2' }, { 'folder-root': folder('folder-root', null) }],
      ['路径中 owner 不匹配', { folderId: 'folder-child', uploaderId: 'user-1' }, {
        'folder-child': folder('folder-child', 'folder-root', { ownerId: 'user-2' }),
        'folder-root': folder('folder-root', null),
      }],
      ['路径中软删除', { folderId: 'folder-child', uploaderId: 'user-1' }, {
        'folder-child': folder('folder-child', 'folder-root'),
        'folder-root': folder('folder-root', null, { isDeleted: true }),
      }],
      ['断链', { folderId: 'folder-child', uploaderId: 'user-1' }, {
        'folder-child': folder('folder-child', 'missing'),
      }],
    ])('文件夹分享：%s 时拒绝', async (_case, file, folders) => {
      const service = makeService();
      mockFolders(service, folders as Record<string, any>);
      (service as any).fileRepo.findOne.mockResolvedValue({ id: 'f1', ...file });
      await expect(service.assertFileInShare(makeLink(), 'f1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('assertFolderInShare', () => {
    it('闭包表缺失时，仍通过 parentId 链允许分享根与多级子目录', async () => {
      const service = makeService();
      mockFolders(service, {
        'folder-root': folder('folder-root', null),
        'folder-mid': folder('folder-mid', 'folder-root'),
        'folder-child': folder('folder-child', 'folder-mid'),
      });

      await expect(service.assertFolderInShare(makeLink(), 'folder-root')).resolves.toBeUndefined();
      await expect(service.assertFolderInShare(makeLink(), 'folder-child')).resolves.toBeUndefined();
      expect((service as any).folderRepo.findAncestors).toBeUndefined();
      expect((service as any).folderRepo.manager).toBeUndefined();
    });

    it('目标不存在或已删除时抛 NotFound', async () => {
      const service = makeService();
      mockFolders(service, {});
      await expect(service.assertFolderInShare(makeLink(), 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('循环、未到达分享根及超过最大深度时拒绝', async () => {
      const cases: Array<Record<string, any>> = [
        { a: folder('a', 'b'), b: folder('b', 'a') },
        { a: folder('a', null) },
        Object.fromEntries(Array.from({ length: 22 }, (_, index) => [
          `n${index}`, folder(`n${index}`, index === 21 ? 'folder-root' : `n${index + 1}`),
        ]).concat([['folder-root', folder('folder-root', null)]])),
      ];
      for (const folders of cases) {
        const service = makeService();
        mockFolders(service, folders);
        await expect(service.assertFolderInShare(makeLink(), Object.keys(folders)[0])).rejects.toBeInstanceOf(ForbiddenException);
      }
    });
  });

  describe('getFolderBreadcrumbForShare', () => {
    it('沿 parentId 链返回从分享根到当前目录的面包屑，不调用 findAncestors', async () => {
      const service = makeService();
      mockFolders(service, {
        'folder-child': folder('folder-child', 'folder-mid', { name: '子' }),
        'folder-mid': folder('folder-mid', 'folder-root', { name: '中间' }),
        'folder-root': folder('folder-root', null, { name: '根' }),
      });
      const result = await service.getFolderBreadcrumbForShare(makeLink(), 'folder-child');
      expect(result).toEqual([
        { id: 'folder-root', name: '根' }, { id: 'folder-mid', name: '中间' }, { id: 'folder-child', name: '子' },
      ]);
      expect((service as any).folderRepo.findAncestors).toBeUndefined();
      expect((service as any).folderRepo.manager).toBeUndefined();
    });

    it('不泄漏分享根之外的祖先，并拒绝无效链', async () => {
      const service = makeService();
      mockFolders(service, {
        'folder-child': folder('folder-child', 'outer'),
        outer: folder('outer', null),
      });
      await expect(service.getFolderBreadcrumbForShare(makeLink(), 'folder-child')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('listFolderContentsForShare', () => {
    it('返回子文件夹与文件，并记录审计', async () => {
      const service = makeService();
      mockFolders(service, { 'folder-root': folder('folder-root', null) });
      (service as any).folderRepo.find.mockResolvedValue([{ id: 'sub-1', name: '子目录', createdAt: new Date(), parentId: 'folder-root' }]);
      (service as any).fileRepo.find.mockResolvedValue([{ id: 'file-1', originalName: 'a.mp4', mimeType: 'video/mp4', size: 100, createdAt: new Date(), uploadVersion: 3, status: 'ready' }]);
      (service as any).fileRepo.count.mockResolvedValue(1);
      const result = await service.listFolderContentsForShare(makeLink(), 'folder-root');
      expect(result.files[0].downloadUrl).toBe('/api/s/tok123/download/file-1');
      expect(result.pagination).toEqual({ page: 1, limit: 100, total: 1, hasMore: false });
      expect((service as any).folderRepo.find).toHaveBeenCalledWith(expect.objectContaining({
        where: { ownerId: 'user-1', parentId: 'folder-root', isDeleted: false },
      }));
      expect((service as any).fileRepo.find).toHaveBeenCalledWith(expect.objectContaining({
        where: { uploaderId: 'user-1', folderId: 'folder-root', isDeleted: false },
      }));
      expect((service as any).fileRepo.count).toHaveBeenCalledWith({
        where: { uploaderId: 'user-1', folderId: 'folder-root', isDeleted: false },
      });
      expect((service as any).audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'share_link_access' }));
    });
  });

  describe('computeShareExpiry', () => {
    it('无有效期返回 null', () => expect(computeShareExpiry(makeLink())).toBeNull());
    it('按 expiresIn 小时计算过期时间', () => {
      const link = makeLink({ expiresIn: 24, expiresStartAt: new Date('2026-08-13T00:00:00.000Z') });
      expect(computeShareExpiry(link)).toBe('2026-08-14T00:00:00.000Z');
    });
  });
});
