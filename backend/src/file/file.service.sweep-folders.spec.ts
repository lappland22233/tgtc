import { Folder } from '../common/entities/folder.entity';
import { File } from '../common/entities/file.entity';
import { FileService } from './file.service';

/**
 * 回收站文件夹清扫的级联安全边界。
 *
 * 背景：`folders.parentId` 是 ON DELETE CASCADE、`files.folderId` 是 ON DELETE SET NULL。
 * 因此数据库层删掉一个父目录，会连带删掉它下面**所有**子目录（含未到期甚至未删除的），
 * 并把其中的文件静默移到根目录。清扫任务必须自己兜住这两点，
 * 只删「彻底为空」的目录。
 */

interface Harness {
  service: FileService;
  folderRepo: Record<string, jest.Mock>;
  fileRepo: Record<string, jest.Mock>;
  namespace: { remove: jest.Mock };
  audit: { logAwait: jest.Mock };
}

/**
 * 构造只覆盖 sweep 路径的最小依赖：直接调用原型方法，
 * 避免拉起 FileService 的二十余项依赖（其中多项是 Bull 队列与网络客户端）。
 */
function makeHarness(fixture: {
  pending: Array<Partial<Folder>>;
  childFolderCount?: number;
  childFileCount?: number;
}): Harness {
  const now = new Date();
  const pending = fixture.pending.map(folder => Object.assign(new Folder(), {
    id: 'f-1', ownerId: 'u-1', name: 'dir', parentId: null,
    isDeleted: true, deleteRequestedAt: now, deleteScheduledAt: new Date(Date.now() - 1000),
    ...folder,
  }));

  const folderRepo: Record<string, jest.Mock> = {
    createQueryBuilder: jest.fn(() => {
      const builder: Record<string, jest.Mock> = {} as Record<string, jest.Mock>;
      builder.where = jest.fn(() => builder);
      builder.andWhere = jest.fn(() => builder);
      builder.take = jest.fn(() => builder);
      builder.getMany = jest.fn(async () => pending);
      return builder;
    }),
    findOne: jest.fn(async () => null),
    count: jest.fn(),
  };

  const fileRepo: Record<string, jest.Mock> = { count: jest.fn() };

  const manager = {
    getRepository: jest.fn((entity: unknown) => {
      if (entity === Folder) {
        return {
          findOne: jest.fn(async (options: { where: { id: string } }) =>
            pending.find(folder => folder.id === options.where.id) ?? null),
          count: jest.fn(async () => fixture.childFolderCount ?? 0),
          remove: jest.fn(async () => undefined),
        };
      }
      if (entity === File) {
        return { count: jest.fn(async () => fixture.childFileCount ?? 0) };
      }
      return { count: jest.fn(async () => 0) };
    }),
  };
  folderRepo.manager = { transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(manager)) } as never;

  const namespace = { remove: jest.fn(async () => undefined) };
  const audit = { logAwait: jest.fn(async () => undefined) };

  // 只调用原型方法：绕过构造函数，避免装配依赖
  const service = Object.create(FileService.prototype) as FileService;
  Object.assign(service as unknown as Record<string, unknown>, {
    folderRepository: folderRepo,
    fileRepository: fileRepo,
    namespaceService: namespace,
    auditService: audit,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  });

  return { service, folderRepo, fileRepo, namespace, audit };
}

describe('FileService.sweepDeletedFolders 级联安全', () => {
  const run = (harness: Harness) =>
    (harness.service as unknown as { sweepDeletedFolders(now: Date): Promise<number> })
      .sweepDeletedFolders(new Date());

  it('目录下仍有子目录时跳过（CASCADE 会连带删掉未到期的子目录）', async () => {
    const harness = makeHarness({ pending: [{ id: 'parent' }], childFolderCount: 1 });

    await expect(run(harness)).resolves.toBe(0);

    // 未执行删除，也未释放名称占用
    expect(harness.namespace.remove).not.toHaveBeenCalled();
  });

  it('目录下仍挂有文件时跳过（SET NULL 会把文件静默移到根目录）', async () => {
    const harness = makeHarness({ pending: [{ id: 'parent' }], childFolderCount: 0, childFileCount: 2 });

    await expect(run(harness)).resolves.toBe(0);
    expect(harness.namespace.remove).not.toHaveBeenCalled();
  });

  it('彻底为空的到期目录才被物理删除，并释放名称占用 + 审计', async () => {
    const harness = makeHarness({ pending: [{ id: 'empty' }], childFolderCount: 0, childFileCount: 0 });

    await expect(run(harness)).resolves.toBe(1);

    expect(harness.namespace.remove).toHaveBeenCalledWith(
      expect.anything(), { entityType: 'folder', entityId: 'empty' },
    );
    expect(harness.audit.logAwait).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'empty', metadata: expect.objectContaining({ source: 'scheduled_sweep' }) }),
    );
  });

  it('未到期的目录即使为空也不删', async () => {
    const harness = makeHarness({
      pending: [{ id: 'future', deleteScheduledAt: new Date(Date.now() + 3600_000) }],
    });

    await expect(run(harness)).resolves.toBe(0);
    expect(harness.namespace.remove).not.toHaveBeenCalled();
  });

  it('已恢复（isDeleted=false）的目录不删', async () => {
    const harness = makeHarness({ pending: [{ id: 'restored', isDeleted: false }] });

    await expect(run(harness)).resolves.toBe(0);
    expect(harness.namespace.remove).not.toHaveBeenCalled();
  });
});
