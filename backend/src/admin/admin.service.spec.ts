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
