import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';

import { AdminService } from './admin.service';
import { SystemConfig } from '../common/entities/system-config.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { File } from '../common/entities/file.entity';
import { User, UserRole } from '../common/entities/user.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { AccessLog } from '../common/entities/access-log.entity';
import { AuditLog } from '../common/entities/audit-log.entity';
import { TelemetryRecord } from '../common/entities/telemetry-record.entity';
import { FileService } from '../file/file.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { AuditService } from '../common/services/audit.service';
import { ExportService } from './export.service';

// ─── helpers ──────────────────────────────────────────────
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'admin-uuid-1',
    email: 'admin@example.com',
    password: 'hashed',
    role: UserRole.ADMIN,
    isBanned: false,
    emailVerified: true,
    ...overrides,
  } as User;
}

function makeFile(overrides: Partial<File> = {}): File {
  return {
    id: 'file-uuid-1',
    filename: 'tg-file-id',
    originalName: 'test.txt',
    mimeType: 'text/plain',
    size: 1024,
    telegramFileId: 'tg-file-id',
    telegramFilePath: '',
    thumbnailPath: null,
    folderId: null,
    folder: null,
    accessType: 'public' as any,
    maxAccessCount: -1,
    expiresIn: null,
    expiresStartAt: null,
    currentAccessCount: 0,
    password: null,
    isDeleted: false,
    deleteRequestedAt: null,
    deleteScheduledAt: null,
    deleteCooldownUntil: null,
    deletedByAdmin: false,
    uploaderId: 'user-uuid-1',
    uploader: null,
    status: 'ready',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as File;
}

// ─── mock factory ─────────────────────────────────────────
const mockRepo = () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  save: jest.fn().mockResolvedValue(undefined),
  create: jest.fn((entity: any) => entity),
  update: jest.fn().mockResolvedValue(undefined),
  delete: jest.fn().mockResolvedValue(undefined),
  count: jest.fn().mockResolvedValue(0),
  remove: jest.fn().mockResolvedValue(undefined),
  createQueryBuilder: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    having: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getRawOne: jest.fn().mockResolvedValue(null),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
    getCount: jest.fn().mockResolvedValue(0),
  })),
});

describe('AdminService', () => {
  let service: AdminService;
  let bannedIPRepo: ReturnType<typeof mockRepo>;
  let fileRepo: ReturnType<typeof mockRepo>;
  let configCacheService: { get: jest.Mock; set: jest.Mock; setBatch: jest.Mock };
  let auditService: { log: jest.Mock };
  let fileService: { forceDelete: jest.Mock; findAll: jest.Mock };

  beforeEach(async () => {
    bannedIPRepo = mockRepo();
    fileRepo = mockRepo();

    configCacheService = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
      setBatch: jest.fn().mockResolvedValue(undefined),
    };

    auditService = { log: jest.fn() };

    fileService = {
      forceDelete: jest.fn().mockResolvedValue(undefined),
      findAll: jest.fn().mockResolvedValue({ files: [], total: 0 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: getRepositoryToken(SystemConfig), useValue: mockRepo() },
        { provide: getRepositoryToken(BannedIP), useValue: bannedIPRepo },
        { provide: getRepositoryToken(File), useValue: fileRepo },
        { provide: getRepositoryToken(User), useValue: mockRepo() },
        { provide: getRepositoryToken(FileAccessLog), useValue: mockRepo() },
        { provide: getRepositoryToken(AccessLog), useValue: mockRepo() },
        { provide: getRepositoryToken(AuditLog), useValue: mockRepo() },
        { provide: getRepositoryToken(TelemetryRecord), useValue: mockRepo() },
        { provide: FileService, useValue: fileService },
        { provide: ConfigCacheService, useValue: configCacheService },
        { provide: AuditService, useValue: auditService },
        { provide: ExportService, useValue: { export: jest.fn() } },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  afterEach(() => jest.clearAllMocks());

  // ═══════════════════════════════════════════════════════════
  //  getConfig() / getConfigByKey()
  // ═══════════════════════════════════════════════════════════
  describe('getConfigByKey', () => {
    it('应从缓存服务获取配置值', async () => {
      configCacheService.get.mockResolvedValue('some-value');

      const result = await service.getConfigByKey('TEST_KEY');
      expect(result).toBe('some-value');
      expect(configCacheService.get).toHaveBeenCalledWith('TEST_KEY', '');
    });

    it('配置不存在时应返回 null', async () => {
      configCacheService.get.mockResolvedValue(null);

      const result = await service.getConfigByKey('NONEXISTENT');
      expect(result).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  updateConfig()
  // ═══════════════════════════════════════════════════════════
  describe('updateConfig', () => {
    it('应成功更新普通配置', async () => {
      const user = makeUser();
      await service.updateConfig(user, 'SITE_NAME', 'My Site', '站点名称');

      expect(configCacheService.set).toHaveBeenCalledWith('SITE_NAME', 'My Site', '站点名称');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'config_change',
          metadata: { value: 'My Site', description: '站点名称' },
        }),
      );
    });

    it('敏感配置键在审计日志中应脱敏', async () => {
      const user = makeUser();
      await service.updateConfig(user, 'SMTP_PASSWORD', 'super-secret', 'SMTP密码');

      const auditCall = auditService.log.mock.calls[0][0];
      expect(auditCall.metadata.value).toBe('***');
      expect(auditCall.metadata.value).not.toBe('super-secret');
    });

    it('超长配置值在审计日志中应截断到 100 字符', async () => {
      const user = makeUser();
      const longValue = 'A'.repeat(200);
      await service.updateConfig(user, 'SITE_NAME', longValue);

      const auditCall = auditService.log.mock.calls[0][0];
      expect(auditCall.metadata.value.length).toBe(100);
    });

    it('JWT_SECRET 也是敏感键应脱敏', async () => {
      const user = makeUser();
      await service.updateConfig(user, 'JWT_SECRET', 'jwt-secret-value');

      const auditCall = auditService.log.mock.calls[0][0];
      expect(auditCall.metadata.value).toBe('***');
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  banIP()
  // ═══════════════════════════════════════════════════════════
  describe('banIP', () => {
    it('应成功封禁新 IP', async () => {
      const user = makeUser();
      // 第一次查询：无活跃封禁；第二次查询：无历史记录
      const mockQB1 = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      } as any;
      const mockQB2 = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      } as any;
      bannedIPRepo.createQueryBuilder
        .mockReturnValueOnce(mockQB1)
        .mockReturnValueOnce(mockQB2);

      bannedIPRepo.create.mockReturnValue({ ip: '1.2.3.4', isPermanent: true });

      await service.banIP(user, '1.2.3.4', '测试封禁', true);

      expect(bannedIPRepo.save).toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ip_ban', resourceId: '1.2.3.4' }),
      );
    });

    it('IP 已被封禁时应抛出 BadRequestException', async () => {
      const user = makeUser();
      const mockQB1 = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: 'ban-id', ip: '1.2.3.4' }),
      } as any;
      bannedIPRepo.createQueryBuilder.mockReturnValueOnce(mockQB1);

      await expect(service.banIP(user, '1.2.3.4', '重复封禁')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('有历史记录时应重新激活而非新建', async () => {
      const user = makeUser();
      const mockQB1 = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      } as any;
      const mockQB2 = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: 'historical-id', ip: '1.2.3.4' }),
      } as any;
      bannedIPRepo.createQueryBuilder
        .mockReturnValueOnce(mockQB1)
        .mockReturnValueOnce(mockQB2);

      await service.banIP(user, '1.2.3.4', '重新封禁', true);

      expect(bannedIPRepo.update).toHaveBeenCalledWith('historical-id', expect.any(Object));
      expect(bannedIPRepo.save).not.toHaveBeenCalled();
    });

    it('临时封禁应设置 expiresAt', async () => {
      const user = makeUser();
      const mockQB1 = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      } as any;
      const mockQB2 = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      } as any;
      bannedIPRepo.createQueryBuilder
        .mockReturnValueOnce(mockQB1)
        .mockReturnValueOnce(mockQB2);

      const expiresAt = new Date(Date.now() + 3600 * 1000);
      bannedIPRepo.create.mockReturnValue({ ip: '1.2.3.4', isPermanent: false });

      await service.banIP(user, '1.2.3.4', '临时封禁', false, expiresAt);

      expect(bannedIPRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ ip: '1.2.3.4', isPermanent: false, expiresAt }),
      );
    });

    it('临时封禁未提供 expiresAt 时应拒绝', async () => {
      const user = makeUser();
      const mockQB1 = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      } as any;
      const mockQB2 = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      } as any;
      bannedIPRepo.createQueryBuilder
        .mockReturnValueOnce(mockQB1)
        .mockReturnValueOnce(mockQB2);

      await expect(service.banIP(user, '1.2.3.4', undefined, false))
        .rejects.toThrow('临时封禁必须提供未来的 expiresAt');
      expect(bannedIPRepo.create).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  unbanIP()
  // ═══════════════════════════════════════════════════════════
  describe('unbanIP', () => {
    it('应成功解封 IP', async () => {
      const user = makeUser();
      const mockQB = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: 'ban-id', ip: '1.2.3.4' }),
      } as any;
      bannedIPRepo.createQueryBuilder.mockReturnValueOnce(mockQB);

      await service.unbanIP(user, '1.2.3.4');

      expect(bannedIPRepo.update).toHaveBeenCalledWith('ban-id', { unbannedAt: expect.any(Date) });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ip_unban', resourceId: '1.2.3.4' }),
      );
    });

    it('IP 未被封禁时应抛出 NotFoundException', async () => {
      const user = makeUser();
      const mockQB = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      } as any;
      bannedIPRepo.createQueryBuilder.mockReturnValueOnce(mockQB);

      await expect(service.unbanIP(user, '1.2.3.4')).rejects.toThrow(NotFoundException);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  deleteFile()
  // ═══════════════════════════════════════════════════════════
  describe('deleteFile', () => {
    it('第一步：应标记文件为待删除', async () => {
      const user = makeUser();
      const file = makeFile({ isDeleted: false, deletedByAdmin: false });
      fileRepo.findOne.mockResolvedValue(file);

      const result = await service.deleteFile(user, 'file-uuid-1');

      expect(result.message).toContain('标记为待删除');
      expect(file.isDeleted).toBe(true);
      expect(file.deletedByAdmin).toBe(true);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'file_delete_by_admin' }),
      );
    });

    it('第二步：已标记删除的文件应永久删除', async () => {
      const user = makeUser();
      const file = makeFile({ isDeleted: true, deletedByAdmin: true });
      fileRepo.findOne.mockResolvedValue(file);

      const result = await service.deleteFile(user, 'file-uuid-1');

      expect(result.message).toBe('文件已永久删除');
      expect(fileService.forceDelete).toHaveBeenCalledWith('file-uuid-1', user);
    });

    it('文件不存在时应抛出 NotFoundException', async () => {
      fileRepo.findOne.mockResolvedValue(null);
      await expect(service.deleteFile(makeUser(), 'nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  batchDeleteFiles()
  // ═══════════════════════════════════════════════════════════
  describe('batchDeleteFiles', () => {
    it('应批量标记文件为待删除', async () => {
      const user = makeUser();
      fileRepo.find.mockResolvedValue([
        makeFile({ id: 'file-1', originalName: 'a.txt' }),
        makeFile({ id: 'file-2', originalName: 'b.txt' }),
      ]);

      await service.batchDeleteFiles(user, ['file-1', 'file-2']);

      expect(fileRepo.update).toHaveBeenCalledWith(
        ['file-1', 'file-2'],
        expect.objectContaining({ isDeleted: true, deletedByAdmin: true }),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'batch_delete_files_by_admin',
          metadata: expect.objectContaining({ count: 2 }),
        }),
      );
    });

    it('无可删除文件时应抛出 NotFoundException', async () => {
      fileRepo.find.mockResolvedValue([]);

      await expect(
        service.batchDeleteFiles(makeUser(), ['nonexistent']),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  getAuthConfig() / updateAuthConfig()
  // ═══════════════════════════════════════════════════════════
  describe('getAuthConfig', () => {
    it('应返回认证配置', async () => {
      configCacheService.get
        .mockResolvedValueOnce('true')   // REGISTRATION_ENABLED
        .mockResolvedValueOnce('false'); // EMAIL_VERIFICATION_ENABLED

      const result = await service.getAuthConfig();

      expect(result.registrationEnabled).toBe(true);
      expect(result.emailVerificationEnabled).toBe(false);
    });
  });

  describe('updateAuthConfig', () => {
    it('应成功更新认证配置并记录审计', async () => {
      const user = makeUser();
      await service.updateAuthConfig(user, {
        registrationEnabled: false,
        emailVerificationEnabled: true,
      });

      expect(configCacheService.set).toHaveBeenCalledWith(
        'REGISTRATION_ENABLED', 'false', expect.any(String),
      );
      expect(configCacheService.set).toHaveBeenCalledWith(
        'EMAIL_VERIFICATION_ENABLED', 'true', expect.any(String),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth_config_change' }),
      );
    });

    it('仅更新提供的字段', async () => {
      const user = makeUser();
      await service.updateAuthConfig(user, { registrationEnabled: true });

      // 只应调用一次 set（仅 REGISTRATION_ENABLED）
      expect(configCacheService.set).toHaveBeenCalledTimes(1);
      expect(configCacheService.set).toHaveBeenCalledWith(
        'REGISTRATION_ENABLED', 'true', expect.any(String),
      );
    });

    it('仅更新 emailVerificationEnabled', async () => {
      await service.updateAuthConfig(makeUser(), { emailVerificationEnabled: false });

      expect(configCacheService.set).toHaveBeenCalledTimes(1);
      expect(configCacheService.set).toHaveBeenCalledWith(
        'EMAIL_VERIFICATION_ENABLED', 'false', expect.any(String),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  getUploadConfig() / updateUploadConfig()
  // ═══════════════════════════════════════════════════════════
  describe('getUploadConfig', () => {
    it('应返回上传配置（含默认值）', async () => {
      configCacheService.get
        .mockResolvedValueOnce('10485760')  // MAX_FILE_SIZE
        .mockResolvedValueOnce('blacklist') // FILE_TYPE_MODE
        .mockResolvedValueOnce('.exe,.bat') // FILE_TYPE_FILTER
        .mockResolvedValueOnce('-1')        // FILE_ACCESS_COUNT_DEFAULT
        .mockResolvedValueOnce('100');      // FILE_ACCESS_COUNT_MAX

      const result = await service.getUploadConfig();

      expect(result.maxFileSize).toBe(10485760);
      expect(result.fileTypeMode).toBe('blacklist');
      expect(result.fileTypeFilter).toBe('.exe,.bat');
      expect(result.accessCountDefault).toBe(-1);
      expect(result.accessCountMax).toBe(100);
    });
  });

  describe('updateUploadConfig', () => {
    it('存在最大次数限制时默认值超限应抛出异常', async () => {
      // 模拟当前配置：max=100, default=50
      configCacheService.get
        .mockResolvedValueOnce('20971520')
        .mockResolvedValueOnce('blacklist')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('50')
        .mockResolvedValueOnce('100');

      await expect(
        service.updateUploadConfig(makeUser(), { accessCountDefault: 200 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('存在最大次数限制时默认值为 -1 应抛出异常', async () => {
      configCacheService.get
        .mockResolvedValueOnce('20971520')
        .mockResolvedValueOnce('blacklist')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('-1')
        .mockResolvedValueOnce('100');

      await expect(
        service.updateUploadConfig(makeUser(), { accessCountDefault: -1 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('应成功更新上传配置', async () => {
      const user = makeUser();
      await service.updateUploadConfig(user, { maxFileSize: 52428800 });

      expect(configCacheService.set).toHaveBeenCalledWith(
        'MAX_FILE_SIZE', '52428800', expect.any(String),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'upload_config_change' }),
      );
    });

    it('应成功更新文件类型模式', async () => {
      await service.updateUploadConfig(makeUser(), { fileTypeMode: 'whitelist' });
      expect(configCacheService.set).toHaveBeenCalledWith(
        'FILE_TYPE_MODE', 'whitelist', expect.any(String),
      );
    });

    it('应成功更新文件类型过滤列表', async () => {
      await service.updateUploadConfig(makeUser(), { fileTypeFilter: '.exe,.bat' });
      expect(configCacheService.set).toHaveBeenCalledWith(
        'FILE_TYPE_FILTER', '.exe,.bat', expect.any(String),
      );
    });

    it('应成功更新访问次数上限', async () => {
      // 当更新 accessCountMax 时，需要校验与当前 default 的一致性
      // mock 当前配置：default=50, max=100（设置新的 max=200 后 50 仍在范围内）
      configCacheService.get
        .mockResolvedValueOnce('20971520')
        .mockResolvedValueOnce('blacklist')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('50')
        .mockResolvedValueOnce('100');

      await service.updateUploadConfig(makeUser(), { accessCountMax: 200 });
      expect(configCacheService.set).toHaveBeenCalledWith(
        'FILE_ACCESS_COUNT_MAX', '200', expect.any(String),
      );
    });

    it('应成功更新默认访问次数（无限制模式）', async () => {
      // 无 max 限制时，default 可设为 -1
      configCacheService.get
        .mockResolvedValueOnce('20971520')
        .mockResolvedValueOnce('blacklist')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('-1')
        .mockResolvedValueOnce('-1');

      await service.updateUploadConfig(makeUser(), { accessCountDefault: -1 });
      expect(configCacheService.set).toHaveBeenCalledWith(
        'FILE_ACCESS_COUNT_DEFAULT', '-1', expect.any(String),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  getCacheConfig() / updateCacheConfig()
  // ═══════════════════════════════════════════════════════════
  describe('getCacheConfig', () => {
    it('应返回缓存配置', async () => {
      configCacheService.get
        .mockResolvedValueOnce('20')  // FILE_CACHE_MAX_SIZE_GB
        .mockResolvedValueOnce('2')   // FILE_CACHE_MIN_FREE_DISK_GB
        .mockResolvedValueOnce('7');  // FILE_CACHE_TTL_DAYS

      const result = await service.getCacheConfig();
      expect(result.maxSizeGB).toBe(20);
      expect(result.minFreeDiskGB).toBe(2);
      expect(result.ttlDays).toBe(7);
    });
  });

  describe('updateCacheConfig', () => {
    it('缓存上限超出范围应抛出异常', async () => {
      await expect(
        service.updateCacheConfig(makeUser(), { maxSizeGB: 0 }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.updateCacheConfig(makeUser(), { maxSizeGB: 2000 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('磁盘剩余空间超出范围应抛出异常', async () => {
      await expect(
        service.updateCacheConfig(makeUser(), { minFreeDiskGB: 0.1 }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.updateCacheConfig(makeUser(), { minFreeDiskGB: 200 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('应成功更新磁盘剩余空间配置', async () => {
      await service.updateCacheConfig(makeUser(), { minFreeDiskGB: 5 });
      expect(configCacheService.set).toHaveBeenCalledWith(
        'FILE_CACHE_MIN_FREE_DISK_GB', '5', expect.any(String),
      );
    });

    it('TTL 超出范围应抛出异常', async () => {
      await expect(
        service.updateCacheConfig(makeUser(), { ttlDays: 0 }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.updateCacheConfig(makeUser(), { ttlDays: 400 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('应成功更新缓存配置', async () => {
      const user = makeUser();
      await service.updateCacheConfig(user, { maxSizeGB: 50, ttlDays: 14 });

      expect(configCacheService.set).toHaveBeenCalledWith(
        'FILE_CACHE_MAX_SIZE_GB', '50', expect.any(String),
      );
      expect(configCacheService.set).toHaveBeenCalledWith(
        'FILE_CACHE_TTL_DAYS', '14', expect.any(String),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'cache_config_change' }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  getBannedIPs()
  // ═══════════════════════════════════════════════════════════
  describe('getBannedIPs', () => {
    it('应返回封禁 IP 列表', async () => {
      const bannedIPs = [
        { id: 'ban-1', ip: '1.2.3.4', reason: '测试', isPermanent: true },
      ];
      bannedIPRepo.find.mockResolvedValue(bannedIPs);

      const result = await service.getBannedIPs();
      expect(result).toEqual(bannedIPs);
      expect(bannedIPRepo.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' } });
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  getAllFiles()
  // ═══════════════════════════════════════════════════════════
  describe('getAllFiles', () => {
    it('应委托给 fileService.findAll', async () => {
      const mockResult = { files: [makeFile()], total: 1 };
      fileService.findAll.mockResolvedValue(mockResult);

      const result = await service.getAllFiles(1, 20, 'test', 'user-1', 'createdAt', 'DESC');
      expect(result).toEqual(mockResult);
      expect(fileService.findAll).toHaveBeenCalledWith(1, 20, 'user-1', 'test', true, 'createdAt', 'DESC', undefined);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  getConfig()
  // ═══════════════════════════════════════════════════════════
  describe('getConfig', () => {
    it('应返回所有系统配置', async () => {
      const configs = [
        { id: 'cfg-1', key: 'SITE_NAME', value: 'Test' },
        { id: 'cfg-2', key: 'MAX_FILE_SIZE', value: '20971520' },
      ];
      const systemConfigRepo = mockRepo();
      systemConfigRepo.find.mockResolvedValue(configs);

      // 重新创建模块以使用新的 mock
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AdminService,
          { provide: getRepositoryToken(SystemConfig), useValue: systemConfigRepo },
          { provide: getRepositoryToken(BannedIP), useValue: mockRepo() },
          { provide: getRepositoryToken(File), useValue: mockRepo() },
          { provide: getRepositoryToken(User), useValue: mockRepo() },
          { provide: getRepositoryToken(FileAccessLog), useValue: mockRepo() },
          { provide: getRepositoryToken(AccessLog), useValue: mockRepo() },
          { provide: getRepositoryToken(AuditLog), useValue: mockRepo() },
          { provide: getRepositoryToken(TelemetryRecord), useValue: mockRepo() },
          { provide: FileService, useValue: fileService },
          { provide: ConfigCacheService, useValue: configCacheService },
          { provide: AuditService, useValue: auditService },
          { provide: ExportService, useValue: { export: jest.fn() } },
        ],
      }).compile();
      const svc = module.get<AdminService>(AdminService);

      const result = await svc.getConfig();
      expect(result).toEqual(configs);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  updateConfigs() (批量)
  // ═══════════════════════════════════════════════════════════
  describe('updateConfigs (batch)', () => {
    it('应批量更新配置并记录审计', async () => {
      const user = makeUser();
      const configs = [
        { key: 'SITE_NAME', value: 'New Site' },
        { key: 'MAX_FILE_SIZE', value: '52428800' },
      ];

      await service.updateConfigs(user, configs);

      expect(configCacheService.setBatch).toHaveBeenCalledWith(configs);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'config_change',
          resourceId: 'batch',
          metadata: { keys: ['SITE_NAME', 'MAX_FILE_SIZE'] },
        }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  getSMTPConfig()
  // ═══════════════════════════════════════════════════════════
  describe('getSMTPConfig', () => {
    it('应返回 SMTP 配置', async () => {
      configCacheService.get
        .mockResolvedValueOnce('smtp.example.com') // SMTP_HOST
        .mockResolvedValueOnce('587')              // SMTP_PORT
        .mockResolvedValueOnce('true')             // SMTP_SECURE
        .mockResolvedValueOnce('user@example.com') // SMTP_USER
        .mockResolvedValueOnce('noreply@example.com'); // SMTP_FROM

      const result = await service.getSMTPConfig();

      expect(result.host).toBe('smtp.example.com');
      expect(result.port).toBe(587);
      expect(result.secure).toBe(true);
      expect(result.user).toBe('user@example.com');
      expect(result.from).toBe('noreply@example.com');
    });

    it('配置缺失时应返回默认值', async () => {
      configCacheService.get
        .mockResolvedValue(null)
        .mockResolvedValue(null)
        .mockResolvedValue(null)
        .mockResolvedValue(null)
        .mockResolvedValue(null);

      const result = await service.getSMTPConfig();

      expect(result.host).toBe('');
      expect(result.port).toBe(587);
      expect(result.secure).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  cleanupExpiredBans()
  // ═══════════════════════════════════════════════════════════
  describe('cleanupExpiredBans', () => {
    it('应清理过期的临时封禁', async () => {
      await service.cleanupExpiredBans();
      expect(bannedIPRepo.update).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  getAdminFileStats()
  // ═══════════════════════════════════════════════════════════
  describe('getAdminFileStats', () => {
    it('应返回管理员的文件统计', async () => {
      const fileRepoQB = fileRepo.createQueryBuilder();
      fileRepoQB.getRawMany.mockResolvedValue([{ fileCount: '10', totalSize: '10240' }]);

      const result = await service.getAdminFileStats('user-uuid-1');

      expect(result).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  updateSMTPConfig()
  // ═══════════════════════════════════════════════════════════
  describe('updateSMTPConfig', () => {
    it('应成功更新 SMTP 配置', async () => {
      // encryptPassword 需要 SMTP_ENCRYPTION_KEY 和 SMTP_ENCRYPTION_SALT 环境变量
      process.env.SMTP_ENCRYPTION_KEY = process.env.SMTP_ENCRYPTION_KEY || 'test-encryption-key-32-bytes-long!!';
      process.env.SMTP_ENCRYPTION_SALT = process.env.SMTP_ENCRYPTION_SALT || 'test-salt-16bytes';

      const user = makeUser();
      await service.updateSMTPConfig(user, {
        host: 'smtp.new.com',
        port: 465,
        secure: true,
        user: 'newuser',
        password: 'newpass',
        from: 'noreply@new.com',
      });

      expect(configCacheService.setBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ key: 'SMTP_HOST', value: 'smtp.new.com' }),
          expect.objectContaining({ key: 'SMTP_PORT', value: '465' }),
          expect.objectContaining({ key: 'SMTP_SECURE', value: 'true' }),
        ]),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'smtp_config_change' }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  getSecurityConfig()
  // ═══════════════════════════════════════════════════════════
  describe('getSecurityConfig', () => {
    it('应返回安全配置列表', async () => {
      configCacheService.get.mockResolvedValue('100');

      const result = await service.getSecurityConfig();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('key');
      expect(result[0]).toHaveProperty('label');
      expect(result[0]).toHaveProperty('currentValue');
      expect(result[0]).toHaveProperty('defaultValue');
    });

    it('配置值不存在时应回退到默认值', async () => {
      configCacheService.get.mockResolvedValue('');

      const result = await service.getSecurityConfig();

      expect(result[0].currentValue).toBe(result[0].defaultValue);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  updateSecurityConfig()
  // ═══════════════════════════════════════════════════════════
  describe('updateSecurityConfig', () => {
    it('无效配置键应抛出 BadRequestException', async () => {
      const user = makeUser();
      await expect(service.updateSecurityConfig(user, [
        { key: 'INVALID_KEY', value: '100' },
      ])).rejects.toThrow(BadRequestException);
    });

    it('应成功批量更新安全配置', async () => {
      const user = makeUser();
      configCacheService.setBatch.mockResolvedValue(undefined);

      await service.updateSecurityConfig(user, [
        { key: 'sec_scan_requests', value: '500' },
        { key: 'sec_scan_paths', value: '100' },
      ]);

      expect(configCacheService.setBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ key: 'sec_scan_requests', value: '500' }),
          expect.objectContaining({ key: 'sec_scan_paths', value: '100' }),
        ]),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'config_change',
          resourceType: 'security_config',
        }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  getStats()
  // ═══════════════════════════════════════════════════════════
  describe('getStats', () => {
    it('应返回统计数据', async () => {
      // getStats 使用 createQueryBuilder，需要 mock 多个 repo
      const mockQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ month: '2026-01', count: '10' }]),
        getRawOne: jest.fn().mockResolvedValue({ count: '5' }),
      };
      // 所有 repo 的 createQueryBuilder 都返回同一个 mockQb
      const systemConfigRepo = mockRepo();
      const userRepo = mockRepo();
      const accessLogRepo = mockRepo();

      // 重新构建 module 以注入带 createQueryBuilder 的 repo
      const module2: TestingModule = await Test.createTestingModule({
        providers: [
          AdminService,
          { provide: getRepositoryToken(SystemConfig), useValue: systemConfigRepo },
          { provide: getRepositoryToken(BannedIP), useValue: mockRepo() },
          { provide: getRepositoryToken(File), useValue: mockRepo() },
          { provide: getRepositoryToken(User), useValue: { ...userRepo, createQueryBuilder: jest.fn().mockReturnValue(mockQb) } },
          { provide: getRepositoryToken(FileAccessLog), useValue: { ...accessLogRepo, createQueryBuilder: jest.fn().mockReturnValue(mockQb) } },
          { provide: getRepositoryToken(AccessLog), useValue: mockRepo() },
          { provide: getRepositoryToken(AuditLog), useValue: mockRepo() },
          { provide: getRepositoryToken(TelemetryRecord), useValue: mockRepo() },
          { provide: FileService, useValue: fileService },
          { provide: ConfigCacheService, useValue: configCacheService },
          { provide: AuditService, useValue: auditService },
          { provide: ExportService, useValue: { export: jest.fn() } },
        ],
      }).compile();
      const svc2 = module2.get<AdminService>(AdminService);

      // fileRepository 也需要 createQueryBuilder
      const fileRepo2 = module2.get(getRepositoryToken(File));
      (fileRepo2 as any).createQueryBuilder = jest.fn().mockReturnValue(mockQb);

      const result = await svc2.getStats();

      expect(result).toHaveProperty('totalUsers');
      expect(result).toHaveProperty('totalFiles');
      expect(result).toHaveProperty('totalStorage');
      expect(result).toHaveProperty('bannedUsers');
      expect(result).toHaveProperty('activeUsers');
      expect(result).toHaveProperty('totalAccessCount');
      expect(result).toHaveProperty('monthlyAccess');
    });
  });
});

