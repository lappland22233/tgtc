import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
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
  let verificationCodeRepo: jest.Mocked<{ createQueryBuilder: jest.Mock; update: jest.Mock; save: jest.Mock }>; 

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
            update: jest.fn(),
            save: jest.fn(),
            createQueryBuilder: jest.fn(),
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
      // Mock createQueryBuilder chain for atomic UPDATE
      const mockUpdateQuery = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      verificationCodeRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnValue(mockUpdateQuery),
      });

      await expect(
        (service as any).validateVerificationCode('test@example.com', '123456', 'register'),
      ).resolves.toBeUndefined();

      // 验证 where 条件包含 email
      const whereCalls = mockUpdateQuery.where.mock.calls;
      expect(whereCalls.some((call: any[]) => call[0] === 'email = :email')).toBe(true);
    });
  });

  describe('无效/过期/已使用验证码', () => {
    it('应抛出 BadRequestException（验证码无效或已过期）', async () => {
      const mockUpdateQuery = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      };
      verificationCodeRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnValue(mockUpdateQuery),
      });

      await expect(
        (service as any).validateVerificationCode('test@example.com', '123456', 'register'),
      ).rejects.toThrow('验证码无效或已过期');
    });

    it('应抛出 BadRequestException（错误验证码）', async () => {
      const mockUpdateQuery = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      };
      verificationCodeRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnValue(mockUpdateQuery),
      });

      await expect(
        (service as any).validateVerificationCode('test@example.com', '999999', 'register'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
