/**
 * B-06 / B-07 回归保护：重命名的并发安全与保留名拦截。
 *
 * 事故形态：
 * - renameFolder 曾在事务外读实体、事务内整实体 save()。陈旧快照会把并发软删写入的
 *   isDeleted / deleteScheduledAt 与并发移动写入的 parentId 一并回写 —— 表现为
 *   「已进回收站的目录被重命名复活」或「并发移动被回滚到旧父级」。
 * - renameFile 曾只做 DTO 字符白名单，未过保留名/设备名拦截，可命名 `..` / `CON.txt`，
 *   下载落盘与 Content-Disposition 在 Windows 上不可用。
 */
import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FolderService } from './folder.service';
import { Folder } from '../common/entities/folder.entity';
import { File } from '../common/entities/file.entity';

const ownerId = '11111111-1111-4111-8111-111111111111';
const folderId = '22222222-2222-4222-8222-222222222222';
const fileId = '33333333-3333-4333-8333-333333333333';

function makeFolderRow(overrides: Partial<Folder> = {}): Folder {
  return Object.assign(new Folder(), {
    id: folderId,
    ownerId,
    name: '旧名称',
    parentId: null,
    isDeleted: false,
    ...overrides,
  });
}

function makeService(opts: { lockedRow?: Folder | null; fileRow?: any } = {}) {
  const folderUpdate = jest.fn().mockResolvedValue({ affected: 1 });
  const folderSave = jest.fn().mockImplementation(async (entity: any) => entity);
  const folderFindOne = jest.fn().mockImplementation(async (arg: any) => {
    // 同层重名探测（where 带 name）默认无冲突；其余为归属校验/行锁重读
    if (arg?.where?.name !== undefined) return null;
    return opts.lockedRow === undefined ? makeFolderRow() : opts.lockedRow;
  });
  const fileUpdate = jest.fn().mockResolvedValue({ affected: 1 });
  const fileFindOne = jest.fn().mockResolvedValue(
    opts.fileRow === undefined
      ? Object.assign(new File(), { id: fileId, uploaderId: ownerId, originalName: '旧文件.pdf', folderId: null })
      : opts.fileRow,
  );

  const folderRepo = {
    findOne: folderFindOne,
    update: folderUpdate,
    save: folderSave,
    manager: {
      transaction: jest.fn(async (cb: any) => cb({
        getRepository: (entity: any) => (entity === Folder
          ? { findOne: folderFindOne, update: folderUpdate, save: folderSave }
          : { findOne: fileFindOne, update: fileUpdate }),
      })),
    },
  };
  const fileRepo = {
    findOne: fileFindOne,
    update: fileUpdate,
    manager: folderRepo.manager,
  };
  const namespace = { acquire: jest.fn().mockResolvedValue(undefined), release: jest.fn() };
  const audit = { log: jest.fn() };

  const service = Object.create(FolderService.prototype) as FolderService;
  Object.assign(service as any, {
    folderRepo,
    fileRepo,
    namespace,
    audit,
    logger: { warn: jest.fn(), log: jest.fn() },
  });
  return { service, folderUpdate, folderSave, folderFindOne, fileUpdate, namespace };
}

describe('renameFolder 并发安全（B-06）', () => {
  it('事务内行锁重读 + 字段级 update，绝不用整实体 save 回写快照', async () => {
    const { service, folderUpdate, folderSave } = makeService();

    await service.renameFolder(ownerId, folderId, { name: '新名称' } as any);

    expect(folderUpdate).toHaveBeenCalledWith(folderId, { name: '新名称' });
    expect(folderSave).not.toHaveBeenCalled();
  });

  it('重读必须带行锁与 isDeleted=false 条件', async () => {
    const { service, folderFindOne } = makeService();

    await service.renameFolder(ownerId, folderId, { name: '新名称' } as any);

    const lockCall = folderFindOne.mock.calls.find(
      ([arg]) => arg && arg.where && arg.where.id === folderId && arg.lock,
    );
    expect(lockCall).toBeDefined();
    expect(lockCall![0].where.isDeleted).toBe(false);
  });

  it('并发软删后行锁重读为空 → 抛 404，不得复活已删目录', async () => {
    const { service, folderUpdate } = makeService({ lockedRow: null });

    await expect(service.renameFolder(ownerId, folderId, { name: '新名称' } as any))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(folderUpdate).not.toHaveBeenCalled();
  });

  it.each(['.', '..', 'CON', 'NUL.txt', 'aux'])('保留名 %s 被拒绝', async (name) => {
    const { service } = makeService();
    await expect(service.renameFolder(ownerId, folderId, { name } as any))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('renameFile 保留名拦截（B-07）', () => {
  it.each(['.', '..', 'CON.txt', 'NUL', 'aux.pdf'])('文件显示名 %s 被拒绝（与文件夹同一套规则）', async (name) => {
    const { service, fileUpdate } = makeService();

    await expect(service.renameFile(ownerId, fileId, { newOriginalName: name } as any))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(fileUpdate).not.toHaveBeenCalled();
  });

  it('合法名称正常重命名，且只写 originalName 字段', async () => {
    const { service, fileUpdate } = makeService();

    await service.renameFile(ownerId, fileId, { newOriginalName: '新文件.pdf' } as any);

    expect(fileUpdate).toHaveBeenCalledWith(fileId, { originalName: '新文件.pdf' });
  });
});