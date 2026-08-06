import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { FolderService } from './folder.service';
import { Folder } from '../common/entities/folder.entity';
import { File } from '../common/entities/file.entity';
import { AuditService } from '../common/services/audit.service';
import { NotFoundException } from '@nestjs/common';

describe('FolderService - createFolder', () => {
  const ownerId = '11111111-1111-4111-8111-111111111111';

  let service: FolderService;
  let folderRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    manager: { query: jest.Mock };
  };
  let audit: { log: jest.Mock; logAwait: jest.Mock };

  beforeEach(async () => {
    folderRepo = {
      findOne: jest.fn(),
      // create 原样返回入参（模拟 TypeORM 用入参构造实体实例），便于断言传给 save 的内容
      create: jest.fn((data: Partial<Folder>) => data as Folder),
      save: jest.fn(async (entity: Folder) => ({ ...entity, id: entity.id ?? '22222222-2222-4222-8222-222222222222' })),
      manager: { query: jest.fn().mockResolvedValue([{ cnt: 1 }]) },
    };
    audit = { log: jest.fn(), logAwait: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        FolderService,
        { provide: getRepositoryToken(Folder), useValue: folderRepo },
        { provide: getRepositoryToken(File), useValue: { findOne: jest.fn(), find: jest.fn() } as Partial<Repository<File>> },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = moduleRef.get(FolderService);
  });

  it('根目录创建（无 parentId）成功，parent 为 null', async () => {
    folderRepo.findOne.mockResolvedValueOnce(null); // 同层级重名检查

    const saved = await service.createFolder(ownerId, { name: '文档' });

    expect(saved.id).toBeDefined();
    expect(saved.name).toBe('文档');
    const createdArg = folderRepo.create.mock.calls[0][0];
    expect(createdArg.parentId).toBeNull();
    expect(createdArg.parent).toBeNull();
    expect(createdArg.ownerId).toBe(ownerId);
    // 重名检查使用 parentId: IsNull()
    expect(folderRepo.findOne).toHaveBeenCalledWith({
      where: { ownerId, parentId: IsNull(), name: '文档', isDeleted: false },
    });
    expect(folderRepo.save).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'folder_create', resourceType: 'folder', resourceId: saved.id }),
    );
  });

  it('带 parentId 创建成功，save 收到的实体 parent 是完整父实体（非仅 {id} 部分对象）', async () => {
    const parentId = '33333333-3333-4333-8333-333333333333';
    const fullParent = Object.assign(new Folder(), {
      id: parentId,
      name: '父文件夹',
      ownerId,
      parentId: null,
      isDeleted: false,
    });
    folderRepo.findOne
      .mockResolvedValueOnce(fullParent) // assertFolderOwned 返回完整父实体
      .mockResolvedValueOnce(null); // 同层级重名检查
    folderRepo.manager.query.mockResolvedValue([{ cnt: 1 }]); // 父级深度 0

    const saved = await service.createFolder(ownerId, { name: '子文件夹', parentId });

    expect(saved.id).toBeDefined();
    const createdArg = folderRepo.create.mock.calls[0][0];
    // 关键断言：parent 必须是 assertFolderOwned 返回的完整父实体（同一引用），
    // 而非 { id: parentId } 这类部分对象
    expect(createdArg.parent).toBe(fullParent);
    expect(createdArg.parent).not.toEqual({ id: parentId });
    expect(createdArg.parentId).toBe(parentId);
    // save 收到的实体与 create 产出一致
    expect(folderRepo.save).toHaveBeenCalledWith(createdArg);
    expect(audit.log).toHaveBeenCalled();
  });

  it('嵌套超过 MAX_FOLDER_DEPTH（20 层）时抛 BadRequestException', async () => {
    const parentId = '44444444-4444-4444-8444-444444444444';
    const deepParent = Object.assign(new Folder(), {
      id: parentId,
      name: '深层父级',
      ownerId,
      isDeleted: false,
    });
    folderRepo.findOne.mockResolvedValue(deepParent); // assertFolderOwned
    // 闭包表祖先数 = 深度 + 1；cnt = 21 表示父级深度已达 20（上限）
    folderRepo.manager.query.mockResolvedValue([{ cnt: 21 }]);

    await expect(service.createFolder(ownerId, { name: '超深层', parentId })).rejects.toThrow(BadRequestException);
    await expect(service.createFolder(ownerId, { name: '超深层', parentId })).rejects.toThrow(/嵌套层级/);
    expect(folderRepo.save).not.toHaveBeenCalled();
  });

  it('同层级重名抛 BadRequestException', async () => {
    folderRepo.findOne.mockResolvedValue(
      Object.assign(new Folder(), {
        id: '55555555-5555-4555-8555-555555555555',
        name: '文档',
        ownerId,
        parentId: null,
        isDeleted: false,
      }),
    ); // 重名检查命中

    await expect(service.createFolder(ownerId, { name: '文档' })).rejects.toThrow(BadRequestException);
    await expect(service.createFolder(ownerId, { name: '文档' })).rejects.toThrow('同层级下已存在同名文件夹');
    expect(folderRepo.create).not.toHaveBeenCalled();
    expect(folderRepo.save).not.toHaveBeenCalled();
  });
});

describe('FolderService - getBreadcrumb', () => {
  const ownerId = '11111111-1111-4111-8111-111111111111';

  let service: FolderService;
  let folderRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    manager: { query: jest.Mock };
  };

  /** 构造一个 folder 实体 */
  function makeFolder(id: string, parentId: string | null, extra: Partial<Folder> = {}): Folder {
    return Object.assign(new Folder(), {
      id,
      name: `folder-${id}`,
      ownerId,
      parentId,
      isDeleted: false,
      ...extra,
    });
  }

  beforeEach(async () => {
    folderRepo = {
      findOne: jest.fn(),
      create: jest.fn((data: Partial<Folder>) => data as Folder),
      save: jest.fn(),
      manager: { query: jest.fn() },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        FolderService,
        { provide: getRepositoryToken(Folder), useValue: folderRepo },
        { provide: getRepositoryToken(File), useValue: { findOne: jest.fn(), find: jest.fn() } as Partial<Repository<File>> },
        { provide: AuditService, useValue: { log: jest.fn(), logAwait: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(FolderService);
  });

  it('folderId 为 null 时返回空数组，不查询数据库', async () => {
    await expect(service.getBreadcrumb(ownerId, null)).resolves.toEqual([]);
    expect(folderRepo.findOne).not.toHaveBeenCalled();
  });

  it('沿 parentId 链上溯，返回根→自身的完整路径（不依赖闭包表）', async () => {
    const root = makeFolder('aaaaaaaa-0000-4000-8000-000000000001', null);
    const mid = makeFolder('aaaaaaaa-0000-4000-8000-000000000002', root.id);
    const leaf = makeFolder('aaaaaaaa-0000-4000-8000-000000000003', mid.id);
    folderRepo.findOne
      .mockResolvedValueOnce(leaf) // assertFolderOwned 目标
      .mockResolvedValueOnce(mid) // 上溯一级
      .mockResolvedValueOnce(root); // 上溯到根

    const crumb = await service.getBreadcrumb(ownerId, leaf.id);

    expect(crumb.map((f) => f.id)).toEqual([root.id, mid.id, leaf.id]);
    // 不应调用任何闭包表查询（findAncestors / manager.query）
    expect(folderRepo.manager.query).not.toHaveBeenCalled();
  });

  it('过滤路径中已删除的祖先节点', async () => {
    const root = makeFolder('bbbbbbbb-0000-4000-8000-000000000001', null, { isDeleted: true });
    const leaf = makeFolder('bbbbbbbb-0000-4000-8000-000000000002', root.id);
    folderRepo.findOne
      .mockResolvedValueOnce(leaf)
      .mockResolvedValueOnce(root);

    const crumb = await service.getBreadcrumb(ownerId, leaf.id);
    expect(crumb.map((f) => f.id)).toEqual([leaf.id]);
  });

  it('目标文件夹不存在或不属于当前用户时抛 NotFoundException', async () => {
    folderRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.getBreadcrumb(ownerId, 'cccccccc-0000-4000-8000-000000000001')).rejects.toThrow(NotFoundException);
  });

  it('parentId 成环的脏数据不会导致无限循环', async () => {
    const a = makeFolder('dddddddd-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000002');
    const b = makeFolder('dddddddd-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000001');
    folderRepo.findOne
      .mockResolvedValueOnce(a)
      .mockResolvedValueOnce(b)
      .mockResolvedValueOnce(a); // 成环

    const crumb = await service.getBreadcrumb(ownerId, a.id);
    // 环被截断，路径有限且不报错
    expect(crumb.length).toBeLessThanOrEqual(2);
    expect(folderRepo.findOne.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('祖先属于其他用户时断链终止，不越权暴露他人数据', async () => {
    const foreign = makeFolder('eeeeeeee-0000-4000-8000-000000000001', null, { ownerId: '99999999-9999-4999-8999-999999999999' });
    const leaf = makeFolder('eeeeeeee-0000-4000-8000-000000000002', foreign.id);
    folderRepo.findOne
      .mockResolvedValueOnce(leaf)
      .mockResolvedValueOnce(foreign);

    const crumb = await service.getBreadcrumb(ownerId, leaf.id);
    expect(crumb.map((f) => f.id)).toEqual([leaf.id]);
  });
});

