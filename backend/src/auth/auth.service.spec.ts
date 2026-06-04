import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository, DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { AuthService } from './auth.service';
import { User } from '../common/entities/user.entity';
import { VerificationCode } from '../common/entities/verification-code.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { SystemConfig } from '../common/entities/system-config.entity';
import { MailerService } from '../mailer/mailer.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { RateLimitService } from '../common/services/rate-limit.service';

describe('AuthService - validateVerificationCode', () => {
  let service: AuthService;
  let verificationCodeRepo: jest.Mocked<Repository<VerificationCode>>;

  const mockUserRepo = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  };

  const mockBannedIPRepo = {
    findOne: jest.fn(),
  };

  const mockSystemConfigRepo = {
    findOne: jest.fn(),
  };

  const mockMailerService = {
    sendVerificationCode: jest.fn(),
  };

  const mockJwtService = {
    sign: jest.fn(),
  };

  const mockDataSource = {
    createQueryRunner: jest.fn().mockReturnValue({
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        create: jest.fn(),
        save: jest.fn(),
      },
      query: jest.fn().mockResolvedValue([{ count: '0' }]),
    }),
  };

  const mockConfigCacheService = {
    get: jest.fn().mockResolvedValue('false'),
  };

  const mockRateLimitService = {
    checkAndIncrement: jest.fn().mockResolvedValue({ allowed: true }),
    reset: jest.fn().mockResolvedValue(undefined),
    getAttemptCount: jest.fn().mockResolvedValue(0),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepo,
        },
        {
          provide: getRepositoryToken(VerificationCode),
          useValue: {
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(BannedIP),
          useValue: mockBannedIPRepo,
        },
        {
          provide: getRepositoryToken(SystemConfig),
          useValue: mockSystemConfigRepo,
        },
        { provide: JwtService, useValue: mockJwtService },
        { provide: MailerService, useValue: mockMailerService },
        { provide: DataSource, useValue: mockDataSource },
        { provide: ConfigCacheService, useValue: mockConfigCacheService },
        { provide: RateLimitService, useValue: mockRateLimitService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    verificationCodeRepo = module.get(getRepositoryToken(VerificationCode));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('有效验证码', () => {
    it('应验证通过并标记为已使用', async () => {
      const futureDate = new Date(Date.now() + 5 * 60 * 1000);
      const codeHash = crypto.createHash('sha256').update('123456').digest('hex');
      const mockCode = {
        id: 'uuid-1',
        email: 'test@example.com',
        code: codeHash,
        type: 'register' as const,
        isUsed: false,
        expiresAt: futureDate,
        createdAt: new Date(),
        attempts: 0,
      };

      // 配置 getConfigValue: 开启邮箱验证
      mockConfigCacheService.get.mockResolvedValueOnce('true').mockResolvedValueOnce('true');
      mockUserRepo.findOne.mockResolvedValueOnce(null); // 邮箱未注册
      mockUserRepo.count.mockResolvedValueOnce(1);
      verificationCodeRepo.findOne.mockResolvedValueOnce(mockCode);
      verificationCodeRepo.update.mockResolvedValueOnce({ affected: 1, raw: [], generatedMaps: [] });

      // 直接调用 protected 方法
      (service as any).validateVerificationCode('test@example.com', '123456', 'register');

      expect(verificationCodeRepo.findOne).toHaveBeenCalledWith({
        where: {
          email: 'test@example.com',
          code: codeHash,
          type: 'register',
          isUsed: false,
          expiresAt: expect.anything(),
        },
      });

      // 验证 MoreThan 查询条件：expiresAt 应大于当前时间
      const callArgs = verificationCodeRepo.findOne.mock.calls[0][0] as { where: { expiresAt: { constructor: { name: string }; type: string }; email: string; code: string; type: string; isUsed: boolean } };
      const expiresAtArg = callArgs.where.expiresAt;
      // MoreThan 返回的 instanceof Raw → 验证其构造
      expect(expiresAtArg.constructor.name).toBe('FindOperator');
      expect(expiresAtArg.type).toBe('moreThan');

      expect(verificationCodeRepo.update).toHaveBeenCalledWith(
        { id: 'uuid-1' },
        { isUsed: true },
      );
    });
  });

  describe('过期验证码', () => {
    it('应抛出 BadRequestException', async () => {
      verificationCodeRepo.findOne.mockResolvedValueOnce(null);

      await expect(
      (service as any).validateVerificationCode('test@example.com', '123456', 'register'),
      ).rejects.toThrow('验证码无效或已过期');

      expect(verificationCodeRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('已使用验证码', () => {
    it('应抛出 BadRequestException（isUsed: false 不匹配已使用记录）', async () => {
      verificationCodeRepo.findOne.mockResolvedValueOnce(null);

      await expect(
      (service as any).validateVerificationCode('test@example.com', '123456', 'register'),
      ).rejects.toThrow('验证码无效或已过期');

      expect(verificationCodeRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('验证码错误（code 不匹配）', () => {
    it('应抛出 BadRequestException', async () => {
      verificationCodeRepo.findOne.mockResolvedValueOnce(null);

      await expect(
      (service as any).validateVerificationCode('test@example.com', '999999', 'register'),
      ).rejects.toThrow(BadRequestException);

      expect(verificationCodeRepo.update).not.toHaveBeenCalled();
    });
  });
});
