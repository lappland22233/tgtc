import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FolderService } from './folder.service';
import { CreateFolderDto, RenameFolderDto } from './folder.dto';
import { Folder } from '../common/entities/folder.entity';
import { File } from '../common/entities/file.entity';
import { AuditService } from '../common/services/audit.service';

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
    // assertFolderOwned 命中父级；随后重名检查需返回 null（不命中）。
    // 用 mockImplementation 区分：重名检查的 where 含 name 字段，返回 null；其余返回 deepParent。
    folderRepo.findOne.mockImplementation(async (opts: any) => {
      if (opts?.where?.name) return null;
      return deepParent;
    });
    // G6-08：深度改沿 parentId 上溯计步。连续返回 20 个父 id（每层一个），
    // 使 getFolderDepth(parentId) 返回 20（已达上限），第 21 次返回 null 表示到根。
    let depthCalls = 0;
    (folderRepo.manager as any).query = jest.fn(async () => {
      depthCalls += 1;
      if (depthCalls <= 20) return [{ parentId: `ancestor-${depthCalls}` }];
      return [{ parentId: null }];
    });

    // 显式 mock getFolderDepth 返回已达上限的深度 20，规避对 manager.query 循环 mock 的依赖
    jest.spyOn(service as any, 'getFolderDepth').mockResolvedValue(20);
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

describe('FolderService - 特殊保留名称校验', () => {
  const ownerId = '11111111-1111-4111-8111-111111111111';

  let service: FolderService;
  let folderRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    manager: { query: jest.Mock };
  };

  beforeEach(async () => {
    folderRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((data: Partial<Folder>) => data as Folder),
      save: jest.fn(async (entity: Folder) => ({ ...entity, id: entity.id ?? '22222222-2222-4222-8222-222222222222' })),
      manager: { query: jest.fn().mockResolvedValue([{ cnt: 1 }]) },
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

  it('createFolder 拒绝 ".."（防路径穿越）', async () => {
    await expect(service.createFolder(ownerId, { name: '..' })).rejects.toThrow('文件夹名称不允许使用保留名称');
    expect(folderRepo.findOne).not.toHaveBeenCalled();
    expect(folderRepo.save).not.toHaveBeenCalled();
  });

  it('createFolder 拒绝 "."', async () => {
    await expect(service.createFolder(ownerId, { name: '.' })).rejects.toThrow(BadRequestException);
    expect(folderRepo.save).not.toHaveBeenCalled();
  });

  it('createFolder 拒绝 Windows 保留设备名（含扩展名，如 CON.txt）', async () => {
    for (const name of ['CON.txt', 'con', 'Nul', 'COM1', 'lpt9.bak']) {
      await expect(service.createFolder(ownerId, { name })).rejects.toThrow('文件夹名称不允许使用保留名称');
    }
    expect(folderRepo.save).not.toHaveBeenCalled();
  });

  it('renameFolder 同样拒绝保留名称', async () => {
    await expect(
      service.renameFolder(ownerId, '66666666-6666-4666-8666-666666666666', { name: '..' }),
    ).rejects.toThrow('文件夹名称不允许使用保留名称');
    expect(folderRepo.findOne).not.toHaveBeenCalled();
  });

  it('合法中文名称正常创建（含空格、点、连字符、下划线）', async () => {
    const saved = await service.createFolder(ownerId, { name: '项目文档 2026.最终版-备份_v2' });
    expect(saved.name).toBe('项目文档 2026.最终版-备份_v2');
    expect(folderRepo.save).toHaveBeenCalledTimes(1);
  });
});

describe('CreateFolderDto / RenameFolderDto - 名称字符集校验', () => {
  it('拒绝包含路径分隔符等非法字符的名称（Create 与 Rename 规则一致）', async () => {
    for (const name of ['../etc', 'a/b', 'a\\b', 'a:b', 'a*b', 'a"b', 'a<b', 'a|b', 'a?b']) {
      const createDto = plainToInstance(CreateFolderDto, { name });
      const createErrors = await validate(createDto, { whitelist: true, forbidNonWhitelisted: true });
      expect(createErrors.map((e) => e.property)).toContain('name');

      const renameDto = plainToInstance(RenameFolderDto, { name });
      const renameErrors = await validate(renameDto, { whitelist: true, forbidNonWhitelisted: true });
      expect(renameErrors.map((e) => e.property)).toContain('name');
    }
  });

  it('接受中英文、数字、空格、点、连字符、下划线与全角空格/点', async () => {
    for (const name of ['文档', 'My Files 2026', '备份-v2_final', '全角\u3000空格\uFF0E点', 'CON']) {
      const dto = plainToInstance(CreateFolderDto, { name });
      await expect(validate(dto, { whitelist: true, forbidNonWhitelisted: true })).resolves.toHaveLength(0);
    }
  });

  it('接受新增白名单字符：半角与全角括号、@ # % $ &（前后端白名单同步）', async () => {
    for (const name of [
      '报告(2026)（最终版）#1&备份$5%',
      'a[1]{b}@c',
      '全角（）［］｛｝＠＃％＄＆', // （）［］｛｝＠＃％＄＆
      '(paren)',
    ]) {
      const dto = plainToInstance(CreateFolderDto, { name });
      await expect(validate(dto, { whitelist: true, forbidNonWhitelisted: true })).resolves.toHaveLength(0);
    }
  });

  it('Transform 先 trim 后再校验：首尾空格不误伤，纯空格拒绝', async () => {
    const trimmed = plainToInstance(CreateFolderDto, { name: '  文档  ' });
    expect(trimmed.name).toBe('文档');
    await expect(validate(trimmed, { whitelist: true, forbidNonWhitelisted: true })).resolves.toHaveLength(0);

    const blank = plainToInstance(CreateFolderDto, { name: '   ' });
    const errors = await validate(blank, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((e) => e.property)).toContain('name');
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

describe('FolderService - moveFolder（G6-02 事务 + FOR UPDATE 锁）', () => {
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const movedId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const parentId = 'aaaaaaaa-0000-4000-8000-000000000002';

  let service: FolderService;
  let folderRepo: any;
  let audit: { log: jest.Mock; logAwait: jest.Mock };

  /** 构造事务 mock：transaction 直接执行回调；manager.query / getRepository 可控 */
  function makeTransactionManager(overrides: Record<string, unknown> = {}) {
    const manager = {
      query: jest.fn(async () => []),
      getRepository: jest.fn(() => ({
        findOne: jest.fn(async () => null),
        save: jest.fn(async (e: Folder) => ({ ...e, id: movedId })),
      })),
      ...overrides,
    };
    return manager;
  }

  beforeEach(async () => {
    folderRepo = {
      findOne: jest.fn(),
      create: jest.fn((data: Partial<Folder>) => data as Folder),
      save: jest.fn(async (entity: Folder) => ({ ...entity, id: entity.id ?? movedId })),
      manager: {
        query: jest.fn(),
        transaction: jest.fn(async (cb: (m: any) => Promise<unknown>) => {
          return cb(makeTransactionManager());
        }),
      },
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

  it('在事务内先 FOR UPDATE 锁定被移动节点，再做校验与保存', async () => {
    // 被移动节点锁定成功
    (folderRepo.manager as any).transaction.mockImplementationOnce(async (cb: any) =>
      cb(makeTransactionManager({
        query: jest.fn(async (sql: string) =>
          sql.includes('FOR UPDATE') ? [{ id: movedId, name: 'moved', parentId: null, isDeleted: false }] : [],
        ),
        getRepository: jest.fn(() => ({
          findOne: jest.fn(async () => null), // 无同名
          save: jest.fn(async (e: Folder) => ({ ...e, id: movedId })),
        })),
      })),
    );

    const saved = await service.moveFolder(ownerId, movedId, { parentId });
    expect(saved.id).toBe(movedId);
    expect(saved.parentId).toBe(parentId);
    // 事务被调用（非裸 save）
    expect(folderRepo.manager.transaction).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'folder_move', resourceId: movedId }),
    );
  });

  it('被移动节点不存在或越权时抛 NotFound，且不落库', async () => {
    (folderRepo.manager as any).transaction.mockImplementationOnce(async (cb: any) =>
      cb(makeTransactionManager({ query: jest.fn(async () => []) })),
    );
    await expect(service.moveFolder(ownerId, movedId, { parentId })).rejects.toThrow(NotFoundException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('把文件夹移入自身抛 BadRequestException', async () => {
    (folderRepo.manager as any).transaction.mockImplementationOnce(async (cb: any) =>
      cb(makeTransactionManager({
        query: jest.fn(async () => [{ id: movedId, name: 'moved', parentId: null, isDeleted: false }]),
      })),
    );
    await expect(service.moveFolder(ownerId, movedId, { parentId: movedId })).rejects.toThrow(BadRequestException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('循环检测：新父级是自身后代时抛 BadRequestException（沿 parentId 上溯）', async () => {
    (folderRepo.manager as any).transaction.mockImplementationOnce(async (cb: any) =>
      cb(makeTransactionManager({
        query: jest.fn(async (sql: string) => {
          // 被移动节点锁定
          if (sql.includes('FOR UPDATE') && sql.includes('$1') && !sql.includes('"parentId"')) {
            return [{ id: movedId, name: 'moved', parentId: null, isDeleted: false }];
          }
          // 新父级锁定
          if (sql.includes('FOR UPDATE')) {
            return [{ id: parentId, name: 'parent', parentId: null, isDeleted: false }];
          }
          // parentId 上溯查询：新父级的父链最终指向 movedId → 说明 moved 是 parent 的祖先
          return [{ parentId: movedId }];
        }),
        getRepository: jest.fn(() => ({ findOne: jest.fn(async () => null), save: jest.fn() })),
      })),
    );
    await expect(service.moveFolder(ownerId, movedId, { parentId })).rejects.toThrow('不能把文件夹移入其自身子树');
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('FolderService - restoreFolder（G6-05 祖先链校验）', () => {
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const folderId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const parentId = 'aaaaaaaa-0000-4000-8000-000000000002';

  let service: FolderService;
  let folderRepo: any;
  let audit: { log: jest.Mock; logAwait: jest.Mock };

  /** 构造事务 mock：transaction 直接执行回调；manager.update 可控 */
  function makeTransactionManager(overrides: Record<string, unknown> = {}) {
    return {
      update: jest.fn(async () => ({ affected: 1 })),
      ...overrides,
    };
  }

  beforeEach(async () => {
    folderRepo = {
      findOne: jest.fn(),
      create: jest.fn((data: Partial<Folder>) => data as Folder),
      save: jest.fn(),
      manager: {
        query: jest.fn().mockResolvedValue([{ id: folderId }]),
        transaction: jest.fn(async (cb: (m: any) => Promise<unknown>) => cb(makeTransactionManager())),
      },
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

  it('祖先链完整（父未被删）时正常恢复', async () => {
    // 待恢复 folder：已软删，有父级
    const folder = Object.assign(new Folder(), { id: folderId, ownerId, parentId, isDeleted: true, deleteScheduledAt: new Date(), deleteRequestedAt: new Date() });
    // 父级未删（恢复父时也需其祖先，这里直接无祖先即返回）
    const parent = Object.assign(new Folder(), { id: parentId, ownerId, parentId: null, isDeleted: false });
    folderRepo.findOne
      .mockResolvedValueOnce(folder) // 查询待恢复 folder
      .mockResolvedValueOnce(parent); // 祖先检查：父级未删
    const manager = makeTransactionManager();
    (folderRepo.manager as any).transaction = jest.fn(async (cb: any) => cb(manager));

    await service.restoreFolder(ownerId, folderId);
    expect(manager.update).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'folder_restore' }));
  });

  it('存在被删祖先时拒绝恢复并提示先恢复上级（幻影根防护）', async () => {
    const folder = Object.assign(new Folder(), { id: folderId, ownerId, parentId, isDeleted: true, deleteScheduledAt: new Date(), deleteRequestedAt: new Date() });
    // 父级仍被软删 → 应拒绝恢复
    const deletedParent = Object.assign(new Folder(), { id: parentId, ownerId, parentId: null, isDeleted: true });
    folderRepo.findOne
      .mockResolvedValueOnce(folder) // 待恢复 folder
      .mockResolvedValueOnce(deletedParent); // 祖先检查命中被删父级

    await expect(service.restoreFolder(ownerId, folderId)).rejects.toThrow('请先恢复上级目录');
    // 不应执行任何恢复更新
    expect(folderRepo.manager.transaction).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('FolderService - copyFile（G6-07 源文件状态校验）', () => {
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const fileId = 'aaaaaaaa-0000-4000-8000-000000000001';

  let service: FolderService;
  let folderRepo: any;
  let fileRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let audit: { log: jest.Mock; logAwait: jest.Mock };

  beforeEach(async () => {
    folderRepo = {
      findOne: jest.fn(),
      create: jest.fn((d: Partial<Folder>) => d as Folder),
      save: jest.fn(),
      manager: { query: jest.fn().mockResolvedValue([{ cnt: 1 }]) },
    };
    fileRepo = {
      findOne: jest.fn(),
      create: jest.fn((d: Partial<File>) => ({ ...d, id: 'bbbbbbbb-0000-4000-8000-000000000002' })),
      save: jest.fn(async (e: Partial<File>) => e),
    };
    audit = { log: jest.fn(), logAwait: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        FolderService,
        { provide: getRepositoryToken(Folder), useValue: folderRepo },
        { provide: getRepositoryToken(File), useValue: fileRepo },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = moduleRef.get(FolderService);
  });

  it('processing 状态的源文件不允许复制，抛 ConflictException', async () => {
    fileRepo.findOne.mockResolvedValueOnce({
      id: fileId, uploaderId: ownerId, isDeleted: false, status: 'processing',
      filename: 'x', originalName: 'a.mp4', mimeType: 'video/mp4', size: 100,
      telegramFileId: 'tg-1', telegramFilePath: '', thumbnailPath: null, folderId: null,
      accessType: 'public', password: null, maxAccessCount: -1, expiresIn: null, expiresStartAt: null,
    });
    await expect(service.copyFile(ownerId, fileId, {})).rejects.toThrow(ConflictException);
    expect(fileRepo.save).not.toHaveBeenCalled();
  });

  it('error 状态的源文件不允许复制，抛 ConflictException', async () => {
    fileRepo.findOne.mockResolvedValueOnce({
      id: fileId, uploaderId: ownerId, isDeleted: false, status: 'error',
      filename: 'x', originalName: 'a.mp4', mimeType: 'video/mp4', size: 100,
      telegramFileId: 'tg-1', telegramFilePath: '', thumbnailPath: null, folderId: null,
      accessType: 'public', password: null, maxAccessCount: -1, expiresIn: null, expiresStartAt: null,
    });
    await expect(service.copyFile(ownerId, fileId, {})).rejects.toThrow(ConflictException);
    expect(fileRepo.save).not.toHaveBeenCalled();
  });

  it('ready 状态的源文件正常复制', async () => {
    fileRepo.findOne
      .mockResolvedValueOnce({
        id: fileId, uploaderId: ownerId, isDeleted: false, status: 'ready',
        filename: 'x', originalName: 'a.mp4', mimeType: 'video/mp4', size: 100,
        telegramFileId: 'tg-1', telegramFilePath: '', thumbnailPath: null, folderId: null,
        accessType: 'public', password: null, maxAccessCount: -1, expiresIn: null, expiresStartAt: null,
      })
      .mockResolvedValueOnce(null); // buildCopyName 无同名
    const saved = await service.copyFile(ownerId, fileId, {});
    expect(saved.id).toBeDefined();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'file_copy' }));
  });
});

