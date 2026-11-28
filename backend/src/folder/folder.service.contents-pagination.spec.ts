import 'reflect-metadata';
import { FolderService } from './folder.service';
import { Folder } from '../common/entities/folder.entity';
import { File } from '../common/entities/file.entity';

/**
 * C-09：/folders/contents 是网盘最常调用的端点。
 * 此前无条件全量加载目录内所有文件，万级目录每次浏览都全表段加载 + 全量序列化。
 * 这里保护两条契约：显式分页只取一页并给出 total；省略分页参数时保持历史全量行为。
 */
const ownerId = '11111111-1111-4111-8111-111111111111';
const folderId = '22222222-2222-4222-8222-222222222222';

function makeService() {
  const subfolders = [Object.assign(new Folder(), { id: 'd1', name: 'docs', ownerId })];
  const files = [Object.assign(new File(), { id: 'f1', originalName: 'a.txt', uploaderId: ownerId })];
  const folderFind = jest.fn().mockResolvedValue(subfolders);
  const fileFind = jest.fn().mockResolvedValue(files);
  const fileFindAndCount = jest.fn().mockResolvedValue([files, 12345]);
  const service = Object.create(FolderService.prototype) as FolderService;
  Object.assign(service as any, {
    folderRepo: { find: folderFind },
    fileRepo: { find: fileFind, findAndCount: fileFindAndCount },
    logger: { warn: jest.fn(), log: jest.fn() },
  });
  // 归属校验直接放行（本用例只关心分页口径）
  (service as any).assertFolderOwned = jest.fn().mockResolvedValue(subfolders[0]);
  return { service, folderFind, fileFind, fileFindAndCount, subfolders, files };
}

describe('listContents 分页（C-09）', () => {
  it('省略 page/limit 时保持历史全量行为，不调用 findAndCount', async () => {
    const { service, fileFind, fileFindAndCount, files, subfolders } = makeService();

    const result = await service.listContents(ownerId, null);

    expect(result).toEqual({ subfolders, files });
    expect(fileFind).toHaveBeenCalledTimes(1);
    expect(fileFindAndCount).not.toHaveBeenCalled();
    expect((result as any).total).toBeUndefined();
  });

  it('显式分页只取一页并返回 total/page/limit', async () => {
    const { service, fileFind, fileFindAndCount, files, subfolders } = makeService();

    const result = await service.listContents(ownerId, folderId, { page: 3, limit: 50 });

    expect(fileFindAndCount).toHaveBeenCalledWith(expect.objectContaining({
      skip: 100,
      take: 50,
      order: { originalName: 'ASC' },
    }));
    expect(fileFind).not.toHaveBeenCalled();
    expect(result).toEqual({ subfolders, files, total: 12345, page: 3, limit: 50 });
  });

  it('第一页 skip 为 0', async () => {
    const { service, fileFindAndCount } = makeService();
    await service.listContents(ownerId, null, { page: 1, limit: 20 });
    expect(fileFindAndCount).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 20 }));
  });

  it('子文件夹始终全量返回，不参与分页', async () => {
    const { service, folderFind, subfolders } = makeService();
    const result = await service.listContents(ownerId, null, { page: 2, limit: 10 });
    expect(folderFind).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ ownerId, isDeleted: false }),
    }));
    expect((result as any).subfolders).toEqual(subfolders);
    expect(folderFind.mock.calls[0][0]).not.toHaveProperty('take');
  });

  it('includeDeleted=false 时文件条件带 isDeleted=false', async () => {
    const { service, fileFindAndCount } = makeService();
    await service.listContents(ownerId, null, { page: 1, limit: 10 });
    expect(fileFindAndCount.mock.calls[0][0].where.isDeleted).toBe(false);
  });

  it('includeDeleted=true 时不加 isDeleted 条件（回收站视图）', async () => {
    const { service, fileFindAndCount } = makeService();
    await service.listContents(ownerId, null, { page: 1, limit: 10, includeDeleted: true });
    expect(fileFindAndCount.mock.calls[0][0].where).not.toHaveProperty('isDeleted');
  });

  it('只传 page 不传 limit 时视为未分页，避免半套参数产生歧义', async () => {
    const { service, fileFind, fileFindAndCount } = makeService();
    await service.listContents(ownerId, null, { page: 2 } as any);
    expect(fileFind).toHaveBeenCalled();
    expect(fileFindAndCount).not.toHaveBeenCalled();
  });

  it('指定 folderId 时先做归属校验', async () => {
    const { service } = makeService();
    await service.listContents(ownerId, folderId, { page: 1, limit: 10 });
    expect((service as any).assertFolderOwned).toHaveBeenCalledWith(folderId, ownerId);
  });
});