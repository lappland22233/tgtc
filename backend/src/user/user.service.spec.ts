import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserService } from './user.service';
import { User, UserRole } from '../common/entities/user.entity';
import { File } from '../common/entities/file.entity';
import { Folder } from '../common/entities/folder.entity';
import { Tag } from '../common/entities/tag.entity';
import { ShareLink, ShareLinkStatus } from '../common/entities/share-link.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { AuditService } from '../common/services/audit.service';

describe('UserService - delete（G6-04 级联处置 folders/tags/ShareLink）', () => {
  const targetId = '22222222-2222-4222-8222-222222222222';
  const requesterId = '33333333-3333-4333-8333-333333333333';

  let service: UserService;
  let manager: {
    findOne: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    softDelete: jest.Mock;
  };
  let audit: { log: jest.Mock; logAwait: jest.Mock };
  let victimRole: UserRole;

  function makeQueryRunner() {
    manager = {
      findOne: jest.fn(async () => ({ id: targetId, email: 'victim@x.com', role: victimRole })),
      update: jest.fn(async () => ({ affected: 1 })),
      delete: jest.fn(async () => ({ affected: 1 })),
      softDelete: jest.fn(async () => ({ affected: 1 })),
    };
    const queryRunner = {
      connect: jest.fn(async () => {}),
      startTransaction: jest.fn(async () => {}),
      commitTransaction: jest.fn(async () => {}),
      rollbackTransaction: jest.fn(async () => {}),
      release: jest.fn(async () => {}),
      manager,
    };
    return queryRunner;
  }

  beforeEach(async () => {
    victimRole = UserRole.USER;
    const dataSource = {
      createQueryRunner: jest.fn(() => makeQueryRunner()),
    };
    audit = { log: jest.fn(), logAwait: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(User), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(File), useValue: {} },
        { provide: getRepositoryToken(FileAccessLog), useValue: {} },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = moduleRef.get(UserService);
  });

  it('同一事务内级联软删文件、文件夹，吊销 ShareLink，删除 Tags，再软删用户', async () => {
    await service.delete(targetId, { id: requesterId, role: UserRole.SUPER_ADMIN } as User);

    // 文件软删（原逻辑）
    expect(manager.update).toHaveBeenCalledWith(
      File,
      { uploaderId: targetId, isDeleted: false },
      expect.objectContaining({ isDeleted: true, deleteRequestedAt: expect.any(Date) }),
    );
    // 文件夹级联软删
    expect(manager.update).toHaveBeenCalledWith(
      Folder,
      { ownerId: targetId, isDeleted: false },
      expect.objectContaining({ isDeleted: true, deleteRequestedAt: expect.any(Date) }),
    );
    // ShareLink 吊销
    expect(manager.update).toHaveBeenCalledWith(
      ShareLink,
      { creatorId: targetId, isDeleted: false },
      expect.objectContaining({ isDeleted: true, status: ShareLinkStatus.DISABLED }),
    );
    // Tags 物理删除
    expect(manager.delete).toHaveBeenCalledWith(Tag, { userId: targetId });
    // 用户软删
    expect(manager.softDelete).toHaveBeenCalledWith(User, { id: targetId });
    // 提交事务
    expect((service as any).dataSource.createQueryRunner).toHaveBeenCalled();
  });

  it('文件与文件夹使用同一删除计划（deleteScheduledAt 相同）', async () => {
    await service.delete(targetId, { id: requesterId, role: UserRole.SUPER_ADMIN } as User);
    const fileCall = manager.update.mock.calls.find((c) => c[0] === File)![2];
    const folderCall = manager.update.mock.calls.find((c) => c[0] === Folder)![2];
    expect(fileCall.deleteScheduledAt).toEqual(folderCall.deleteScheduledAt);
    expect(fileCall.deleteRequestedAt).toEqual(folderCall.deleteRequestedAt);
  });

  it('禁止删除自己', async () => {
    await expect(service.delete(requesterId, { id: requesterId } as User)).rejects.toThrow(BadRequestException);
  });

  it('ADMIN 不能删除其他 ADMIN', async () => {
    victimRole = UserRole.ADMIN;
    await expect(service.delete(targetId, { id: requesterId, role: UserRole.ADMIN } as User)).rejects.toThrow(ForbiddenException);
    // 不应执行任何级联清理
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.softDelete).not.toHaveBeenCalled();
  });
});

describe('UserService - updateRole（G6-09 自我降级 + 最后超管保护）', () => {
  const adminId = '44444444-4444-4444-8444-444444444444';
  const targetId = '55555555-5555-4555-8555-555555555555';

  let service: UserService;
  let userRepo: { findOne: jest.Mock; count: jest.Mock; update: jest.Mock };
  let audit: { log: jest.Mock; logAwait: jest.Mock };

  beforeEach(async () => {
    userRepo = { findOne: jest.fn(), count: jest.fn(), update: jest.fn() };
    audit = { log: jest.fn(), logAwait: jest.fn() };
    const dataSource = { createQueryRunner: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(File), useValue: {} },
        { provide: getRepositoryToken(FileAccessLog), useValue: {} },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = moduleRef.get(UserService);
  });

  it('禁止修改自己的角色（防 super_admin 自我降级）', async () => {
    await expect(
      service.updateRole(adminId, UserRole.ADMIN, { id: adminId, role: UserRole.SUPER_ADMIN } as User),
    ).rejects.toThrow(BadRequestException);
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  it('非 super_admin 无权修改角色', async () => {
    await expect(
      service.updateRole(targetId, UserRole.ADMIN, { id: adminId, role: UserRole.ADMIN } as User),
    ).rejects.toThrow(BadRequestException);
  });

  it('系统仅剩一个 super_admin 时拒绝降级操作', async () => {
    userRepo.findOne.mockResolvedValue({ id: targetId, role: UserRole.USER });
    userRepo.count.mockResolvedValue(1); // 仅 1 个 super_admin（即操作者）
    await expect(
      service.updateRole(targetId, UserRole.ADMIN, { id: adminId, role: UserRole.SUPER_ADMIN } as User),
    ).rejects.toThrow('系统至少需保留一个超级管理员');
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  it('存在多个 super_admin 时正常修改他人角色', async () => {
    userRepo.findOne.mockResolvedValue({ id: targetId, role: UserRole.USER });
    userRepo.count.mockResolvedValue(2); // 多个 super_admin
    await service.updateRole(targetId, UserRole.ADMIN, { id: adminId, role: UserRole.SUPER_ADMIN } as User);
    expect(userRepo.update).toHaveBeenCalledWith(targetId, { role: UserRole.ADMIN });
    expect(audit.logAwait).toHaveBeenCalledWith(expect.objectContaining({ action: 'role_change' }));
  });
});

describe('UserService - create（G6-10 软删邮箱占用提示）', () => {
  const adminId = '66666666-6666-4666-8666-666666666666';

  let service: UserService;
  let userRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let audit: { log: jest.Mock; logAwait: jest.Mock };

  beforeEach(async () => {
    userRepo = {
      findOne: jest.fn(),
      create: jest.fn((d: Partial<User>) => ({ id: '77777777-7777-4777-8777-777777777777', ...d })),
      save: jest.fn(async (u: Partial<User>) => u),
    };
    audit = { log: jest.fn(), logAwait: jest.fn() };
    const dataSource = { createQueryRunner: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(File), useValue: {} },
        { provide: getRepositoryToken(FileAccessLog), useValue: {} },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = moduleRef.get(UserService);
  });

  it('邮箱被已软删用户占用时，提示可重新激活而非含糊冲突', async () => {
    // withDeleted(true) 命中已软删用户
    userRepo.findOne.mockResolvedValue({ id: '88888888-8888-4888-8888-888888888888', email: 'a@x.com', deletedAt: new Date() });
    await expect(
      service.create({ email: 'A@X.COM', password: 'secret123', role: UserRole.USER }, { id: adminId, role: UserRole.SUPER_ADMIN } as User),
    ).rejects.toThrow('重新激活');
    // 应使用 withDeleted:true 查询
    expect(userRepo.findOne).toHaveBeenCalledWith(expect.objectContaining({ withDeleted: true }));
    expect(userRepo.save).not.toHaveBeenCalled();
  });

  it('邮箱被未删除用户占用时提示已注册', async () => {
    userRepo.findOne.mockResolvedValue({ id: '99999999-9999-4999-8999-999999999999', email: 'a@x.com', deletedAt: null });
    await expect(
      service.create({ email: 'a@x.com', password: 'secret123', role: UserRole.USER }, { id: adminId, role: UserRole.SUPER_ADMIN } as User),
    ).rejects.toThrow('该邮箱已被注册');
  });
});
