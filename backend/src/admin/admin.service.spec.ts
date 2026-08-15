import 'reflect-metadata';

// FileService 依赖链含 file-type（ESM-only），且本测试仅关心其余管理逻辑，直接 mock
jest.mock('../file/file.service', () => ({ FileService: class FileService {} }));

import { AdminService } from './admin.service';

function buildAdminService() {
  const fileRepository = {
    createQueryBuilder: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const auditService = { log: jest.fn(), logAwait: jest.fn() };
  const repoMock = () => ({}) as any;
  const service = new AdminService(
    repoMock(), // systemConfigRepository
    repoMock(), // bannedIPRepository
    fileRepository as any, // fileRepository
    repoMock(), // userRepository
    repoMock(), // accessLogRepository
    repoMock(), // accessLogRepo
    repoMock(), // auditLogRepo
    repoMock(), // telemetryRepo
    {} as any, // fileService
    {} as any, // configCacheService
    auditService as any,
    {} as any, // exportService
    {} as any, // mailerService
  );
  return { service, fileRepository, auditService };
}

describe('AdminService 构造', () => {
  it('buildAdminService 可正常实例化（13 个依赖占位）', () => {
    const { service, fileRepository } = buildAdminService();
    expect(service).toBeInstanceOf(AdminService);
    expect(fileRepository.createQueryBuilder).toBeDefined();
  });
});

describe('AdminService.cleanupStalePaths', () => {
  const user = { id: 'user-1', email: 'admin@example.com' } as any;

  /** 构造 dry-run 用计数查询链 */
  function mockCountQuery(fileRepository: any, count: number) {
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(count),
    };
    fileRepository.createQueryBuilder.mockReturnValue(qb);
    return qb;
  }

  /** 构造 apply 用：先计数查询，后 update 链 */
  function mockApplyQuery(fileRepository: any, count: number, affected: number) {
    const countQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(count),
    };
    const updateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected }),
    };
    fileRepository.createQueryBuilder
      .mockReturnValueOnce(countQb)
      .mockReturnValueOnce(updateQb);
    return { countQb, updateQb };
  }

  it('dry-run 只统计不更新，返回 matched 且 updated=0，审计只含模式与数量', async () => {
    const { service, fileRepository, auditService } = buildAdminService();
    const qb = mockCountQuery(fileRepository, 42);

    const result = await service.cleanupStalePaths(user, 'dry-run');

    expect(result).toEqual({ mode: 'dry-run', matched: 42, updated: 0 });
    // 未调用 update 链
    expect(fileRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(fileRepository.createQueryBuilder).toHaveBeenCalledWith('file');
    expect(qb.andWhere).toHaveBeenCalled();
    expect(qb.getCount).toHaveBeenCalledTimes(1);
    // 审计：log（非 logAwait），metadata 只含模式与数量，不含路径
    expect(auditService.log).toHaveBeenCalledTimes(1);
    expect(auditService.logAwait).not.toHaveBeenCalled();
    const auditCall = auditService.log.mock.calls[0][0];
    expect(auditCall.action).toBe('file_stale_path_cleanup');
    expect(auditCall.metadata).toEqual({ mode: 'dry-run', matched: 42, updated: 0 });
    expect(JSON.stringify(auditCall.metadata)).not.toContain('/data/cb');
  });

  it('apply 条件更新带正确 WHERE（参数化、isDeleted=false、前缀精确匹配）', async () => {
    const { service, fileRepository, auditService } = buildAdminService();
    const { updateQb } = mockApplyQuery(fileRepository, 100, 100);

    const result = await service.cleanupStalePaths(user, 'apply');

    expect(result).toEqual({ mode: 'apply', matched: 100, updated: 100 });
    expect(fileRepository.createQueryBuilder).toHaveBeenCalledTimes(2);
    // 第二次调用为 update 链（无别名）
    expect(fileRepository.createQueryBuilder).toHaveBeenNthCalledWith(2);
    expect(updateQb.update).toHaveBeenCalledWith(expect.anything());
    expect(updateQb.set).toHaveBeenCalledWith({ telegramFilePath: null });
    // WHERE 条件：isDeleted=false + telegramFilePath 非空 + LIKE 精确前缀
    const whereCalls = updateQb.where.mock.calls.concat(updateQb.andWhere.mock.calls);
    const whereSql = whereCalls.map((c: any[]) => c[0]).join(' ');
    expect(whereSql).toContain('isDeleted = false');
    expect(whereSql).toContain('telegramFilePath');
    expect(whereSql).toContain('LIKE');
    // 参数化：前缀为固定值 + 通配符，不接受任意 SQL
    const prefixParam = updateQb.andWhere.mock.calls
      .map((c: any[]) => c[1])
      .find((p: any) => p && typeof p.prefix === 'string');
    expect(prefixParam.prefix).toBe('/data/cb/tgtc-beta/%');
    // apply 使用 logAwait，metadata 不含路径
    expect(auditService.logAwait).toHaveBeenCalledTimes(1);
    expect(auditService.log).not.toHaveBeenCalled();
    const auditCall = auditService.logAwait.mock.calls[0][0];
    expect(auditCall.action).toBe('file_stale_path_cleanup');
    expect(auditCall.metadata).toEqual({ mode: 'apply', matched: 100, updated: 100 });
    expect(JSON.stringify(auditCall.metadata)).not.toContain('/data/cb');
  });

  it('幂等：第二次执行命中 0 条', async () => {
    const { service, fileRepository } = buildAdminService();
    mockApplyQuery(fileRepository, 0, 0);

    const result = await service.cleanupStalePaths(user, 'apply');

    expect(result).toEqual({ mode: 'apply', matched: 0, updated: 0 });
  });
});
