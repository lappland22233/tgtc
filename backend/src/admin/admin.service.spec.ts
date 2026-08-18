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

describe('AdminService 通用配置写入白名单 (G7-01)', () => {
  const user = { id: 'user-1', email: 'admin@example.com' } as any;

  it('updateConfig 拒绝 sec_* 安全键（必须走安全配置专用端点）', async () => {
    const { service } = buildAdminService();
    await expect(
      service.updateConfig(user, 'sec_scan_requests', '1'),
    ).rejects.toThrow('必须通过安全配置专用端点');
  });

  it('updateConfig 拒绝 SMTP_PASSWORD（必须走加密专用端点）', async () => {
    const { service } = buildAdminService();
    await expect(
      service.updateConfig(user, 'SMTP_PASSWORD', 'plaintext'),
    ).rejects.toThrow('必须通过专用端点更新');
  });

  it('updateConfig 拒绝白名单之外的未知键', async () => {
    const { service } = buildAdminService();
    await expect(
      service.updateConfig(user, 'ARBITRARY_NEW_KEY', 'x'),
    ).rejects.toThrow('不允许通过通用配置端点修改未声明的键');
  });

  it('updateConfig 允许白名单内的普通配置键并写入', async () => {
    const { auditService } = buildAdminService();
    const configCache = {
      set: jest.fn().mockResolvedValue(undefined),
      setBatch: jest.fn().mockResolvedValue(undefined),
    };
    // 用自定义 configCacheService 构造 service
    const fileRepository = { createQueryBuilder: jest.fn(), find: jest.fn(), findOne: jest.fn(), update: jest.fn() };
    const repoMock = () => ({}) as any;
    const svc = new AdminService(
      repoMock(), repoMock(), fileRepository as any, repoMock(), repoMock(),
      repoMock(), repoMock(), repoMock(), {} as any, configCache as any,
      auditService as any, {} as any, {} as any,
    );

    await svc.updateConfig(user, 'MAX_FILE_SIZE', '20971520');

    expect(configCache.set).toHaveBeenCalledWith('MAX_FILE_SIZE', '20971520', undefined);
    expect(auditService.log).toHaveBeenCalledTimes(1);
  });

  it('updateConfigs 批量入口也逐键执行白名单校验', async () => {
    const { service } = buildAdminService();
    await expect(
      service.updateConfigs(user, [
        { key: 'MAX_FILE_SIZE', value: '100' },
        { key: 'sec_scan_requests', value: '1' },
      ]),
    ).rejects.toThrow('必须通过安全配置专用端点');
  });
});

describe('AdminService.getConfig 敏感键掩码 (G7-03)', () => {
  it('SMTP_PASSWORD 等敏感键返回 ***，普通键原样返回', async () => {
    const systemConfigRepository = {
      find: jest.fn().mockResolvedValue([
        { key: 'SMTP_PASSWORD', value: 'encrypted-secret' },
        { key: 'MAX_FILE_SIZE', value: '20971520' },
        { key: 'TELEGRAM_BOT_TOKEN', value: 'tok' },
      ]),
    };
    const repoMock = () => ({}) as any;
    const fileRepository = { createQueryBuilder: jest.fn(), find: jest.fn(), findOne: jest.fn(), update: jest.fn() };
    const auditService = { log: jest.fn(), logAwait: jest.fn() };
    const svc = new AdminService(
      systemConfigRepository as any, repoMock(), fileRepository as any, repoMock(),
      repoMock(), repoMock(), repoMock(), repoMock(), {} as any, {} as any,
      auditService as any, {} as any, {} as any,
    );

    const configs = await svc.getConfig();
    expect(configs).toEqual([
      { key: 'SMTP_PASSWORD', value: '***' },
      { key: 'MAX_FILE_SIZE', value: '20971520' },
      { key: 'TELEGRAM_BOT_TOKEN', value: '***' },
    ]);
  });
});

describe('AdminService.getLatencyStats endDate 口径 (G7-05)', () => {
  it('totalCount 查询同步追加 endDate 条件', async () => {
    const accessLogRepo = {
      createQueryBuilder: jest.fn(),
    };
    const countQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(100),
    };
    const statsQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue(null),
    };
    // 第一次调用 -> countQb；第二次调用 -> statsQb
    accessLogRepo.createQueryBuilder
      .mockReturnValueOnce(countQb)
      .mockReturnValueOnce(statsQb);

    const repoMock = () => ({}) as any;
    const fileRepository = { createQueryBuilder: jest.fn(), find: jest.fn(), findOne: jest.fn(), update: jest.fn() };
    const auditService = { log: jest.fn(), logAwait: jest.fn() };
    const svc = new AdminService(
      repoMock(), repoMock(), fileRepository as any, repoMock(), repoMock(),
      accessLogRepo as any, repoMock(), repoMock(), {} as any, {} as any,
      auditService as any, {} as any, {} as any,
    );

    const result = await svc.getLatencyStats({
      startDate: '2026-08-01T00:00:00Z',
      endDate: '2026-08-10T00:00:00Z',
    } as any);

    // count 查询应追加 endDate 条件
    expect(countQb.andWhere).toHaveBeenCalled();
    const untilCall = countQb.andWhere.mock.calls.find((c: any[]) => c[0] === 'log.createdAt <= :until');
    expect(untilCall).toBeDefined();
    expect(untilCall[1].until).toBeInstanceOf(Date);
    expect(result.totalRequests).toBe(100);
  });
});

describe('AdminService.updateSecurityConfig 归一化 (G7-06)', () => {
  const user = { id: 'user-1', email: 'admin@example.com' } as any;
  const SEC_KEYS = require('./security-config.defaults').SEC_CONFIG_KEYS;

  it('指数形式输入入库前归一化为十进制字符串', async () => {
    const configCache = {
      get: jest.fn(),
      setBatch: jest.fn().mockResolvedValue(undefined),
    };
    const repoMock = () => ({}) as any;
    const fileRepository = { createQueryBuilder: jest.fn(), find: jest.fn(), findOne: jest.fn(), update: jest.fn() };
    const auditService = { log: jest.fn(), logAwait: jest.fn() };
    const svc = new AdminService(
      repoMock(), repoMock(), fileRepository as any, repoMock(), repoMock(),
      repoMock(), repoMock(), repoMock(), {} as any, configCache as any,
      auditService as any, {} as any, {} as any,
    );

    // 使用 scan 请求阈值键，'1e3' -> Number('1e3')=1000 -> String(1000)='1000'
    await svc.updateSecurityConfig(user, [
      { key: SEC_KEYS.SCAN_REQUESTS_THRESHOLD, value: '1e3' },
    ]);

    expect(configCache.setBatch).toHaveBeenCalledTimes(1);
    const entries = configCache.setBatch.mock.calls[0][0];
    expect(entries[0].key).toBe(SEC_KEYS.SCAN_REQUESTS_THRESHOLD);
    expect(entries[0].value).toBe('1000');
  });

  it('非法数值仍被拒绝（不落库）', async () => {
    const configCache = { get: jest.fn(), setBatch: jest.fn() };
    const repoMock = () => ({}) as any;
    const fileRepository = { createQueryBuilder: jest.fn(), find: jest.fn(), findOne: jest.fn(), update: jest.fn() };
    const auditService = { log: jest.fn(), logAwait: jest.fn() };
    const svc = new AdminService(
      repoMock(), repoMock(), fileRepository as any, repoMock(), repoMock(),
      repoMock(), repoMock(), repoMock(), {} as any, configCache as any,
      auditService as any, {} as any, {} as any,
    );

    await expect(
      svc.updateSecurityConfig(user, [
        { key: SEC_KEYS.SCAN_REQUESTS_THRESHOLD, value: 'abc' },
      ]),
    ).rejects.toThrow('必须为有效数值');
    expect(configCache.setBatch).not.toHaveBeenCalled();
  });
});
