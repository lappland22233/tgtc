import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { User, UserRole } from '../common/entities/user.entity';
import { VerificationCode } from '../common/entities/verification-code.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { SystemConfig } from '../common/entities/system-config.entity';
import { MailerService } from '../mailer/mailer.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { RateLimitService } from '../common/services/rate-limit.service';
import { AuditService } from '../common/services/audit.service';

describe('AuthService - validateVerificationCode', () => {
  let service: AuthService;
  let verificationCodeRepo: jest.Mocked<{ createQueryBuilder: jest.Mock; update: jest.Mock; save: jest.Mock }>; 

  // AuthService 构造函数要求 CODE_HMAC_SECRET 或 JWT_SECRET 环境变量存在
  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
  });

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

  const mockAuditService = {
    log: jest.fn(),
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
        { provide: AuditService, useValue: mockAuditService },
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

// ════════════════════════════════════════════════════════════════════════════
//  AuthService - login / validateUser / getAuthStatus / resetPassword
// ════════════════════════════════════════════════════════════════════════════
describe('AuthService - login & other methods', () => {
  let service: AuthService;
  let userRepo: any;
  let bannedIPRepo: any;
  let configCacheService: any;
  let rateLimitService: any;
  let jwtService: any;
  let auditService: any;
  let mailerService: any;
  let verificationCodeRepo: any;

  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
  });

  beforeEach(async () => {
    userRepo = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    };

    bannedIPRepo = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    verificationCodeRepo = {
      findOne: jest.fn(),
      update: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    configCacheService = {
      get: jest.fn().mockResolvedValue('false'),
    };

    rateLimitService = {
      checkAndIncrement: jest.fn().mockResolvedValue({ allowed: true }),
      reset: jest.fn().mockResolvedValue(undefined),
      getAttemptCount: jest.fn().mockResolvedValue(0),
    };

    jwtService = {
      sign: jest.fn().mockReturnValue('mock-token'),
    };

    auditService = { log: jest.fn() };
    mailerService = { sendVerificationCode: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(VerificationCode), useValue: verificationCodeRepo },
        { provide: getRepositoryToken(BannedIP), useValue: bannedIPRepo },
        { provide: getRepositoryToken(SystemConfig), useValue: { findOne: jest.fn() } },
        { provide: JwtService, useValue: jwtService },
        { provide: MailerService, useValue: mailerService },
        {
          provide: DataSource,
          useValue: {
            createQueryRunner: jest.fn().mockReturnValue({
              connect: jest.fn(),
              startTransaction: jest.fn(),
              commitTransaction: jest.fn(),
              rollbackTransaction: jest.fn(),
              release: jest.fn(),
              isTransactionActive: false,
              manager: { create: jest.fn(), save: jest.fn() },
              query: jest.fn().mockResolvedValue([{ count: '0' }]),
            }),
            transaction: jest.fn((cb) => cb({
              update: jest.fn().mockResolvedValue(undefined),
              create: jest.fn().mockReturnValue({}),
              save: jest.fn().mockResolvedValue(undefined),
            })),
          },
        },
        { provide: ConfigCacheService, useValue: configCacheService },
        { provide: RateLimitService, useValue: rateLimitService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── login ───────────────────────────────────────────────
  describe('login', () => {
    it('IP 被永久封禁时应抛出 UnauthorizedException', async () => {
      bannedIPRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ isPermanent: true }),
      });

      await expect(
        service.login({ email: 'test@example.com', password: 'pass' }, '1.2.3.4'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('IP 被临时封禁时应抛出 UnauthorizedException', async () => {
      bannedIPRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ isPermanent: false }),
      });

      await expect(
        service.login({ email: 'test@example.com', password: 'pass' }, '1.2.3.4'),
      ).rejects.toThrow('您的IP已被临时封禁');
    });

    it('用户不存在时应抛出 UnauthorizedException', async () => {
      bannedIPRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });
      userRepo.findOne.mockResolvedValue(null);

      await expect(
        service.login({ email: 'test@example.com', password: 'pass' }, '1.2.3.4'),
      ).rejects.toThrow('邮箱或密码错误');
    });

    it('用户被封禁时应抛出 UnauthorizedException', async () => {
      bannedIPRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });
      userRepo.findOne.mockResolvedValue({ id: 'u1', isBanned: true });

      await expect(
        service.login({ email: 'test@example.com', password: 'pass' }, '1.2.3.4'),
      ).rejects.toThrow('账号已被封禁');
    });

    it('密码错误时应抛出 UnauthorizedException', async () => {
      bannedIPRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });
      const hashed = bcrypt.hashSync('correct-pass', 10);
      userRepo.findOne.mockResolvedValue({
        id: 'u1', email: 'test@example.com', password: hashed,
        isBanned: false, emailVerified: true, role: UserRole.USER,
      });

      await expect(
        service.login({ email: 'test@example.com', password: 'wrong-pass' }, '1.2.3.4'),
      ).rejects.toThrow('邮箱或密码错误');
    });

    it('邮箱未验证时应抛出 UnauthorizedException', async () => {
      bannedIPRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });
      userRepo.findOne.mockResolvedValue({
        id: 'u1', isBanned: false, emailVerified: false,
      });
      configCacheService.get.mockResolvedValue('true'); // EMAIL_VERIFICATION_ENABLED

      await expect(
        service.login({ email: 'test@example.com', password: 'pass' }, '1.2.3.4'),
      ).rejects.toThrow('请先验证邮箱');
    });

    it('登录成功应返回 accessToken', async () => {
      bannedIPRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });
      const hashed = bcrypt.hashSync('correct-pass', 10);
      userRepo.findOne.mockResolvedValue({
        id: 'u1', email: 'test@example.com', password: hashed,
        isBanned: false, emailVerified: true, role: UserRole.USER,
      });
      userRepo.update.mockResolvedValue(undefined);

      const result = await service.login(
        { email: 'test@example.com', password: 'correct-pass' }, '1.2.3.4',
      );

      expect(result.accessToken).toBe('mock-token');
      expect(result.user.email).toBe('test@example.com');
    });

    it('登录失败次数过多应抛出限流异常', async () => {
      bannedIPRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });
      userRepo.findOne.mockResolvedValue(null);
      rateLimitService.checkAndIncrement.mockResolvedValue({
        allowed: false, waitMinutes: 15,
      });

      await expect(
        service.login({ email: 'test@example.com', password: 'pass' }, '1.2.3.4'),
      ).rejects.toThrow('登录失败次数过多');
    });
  });

  // ─── validateUser ────────────────────────────────────────
  describe('validateUser', () => {
    it('非 UUID 格式应返回 null', async () => {
      const result = await service.validateUser('not-a-uuid');
      expect(result).toBeNull();
    });

    it('UUID 格式应查询用户', async () => {
      userRepo.findOne.mockResolvedValue({ id: 'valid-uuid' });
      const result = await service.validateUser('12345678-1234-1234-1234-123456789012');
      expect(result).toEqual({ id: 'valid-uuid' });
    });
  });

  // ─── getAuthStatus ───────────────────────────────────────
  describe('getAuthStatus', () => {
    it('无用户时应允许注册且无超管', async () => {
      userRepo.count.mockResolvedValue(0);
      configCacheService.get.mockResolvedValue('false');

      const result = await service.getAuthStatus();

      expect(result.registrationEnabled).toBe(true);
      expect(result.emailVerificationEnabled).toBe(false);
      expect(result.hasSuperAdmin).toBe(false);
    });

    it('有用户且注册开启时应返回正确状态', async () => {
      userRepo.count.mockResolvedValue(5);
      configCacheService.get.mockImplementation((key: string) => {
        if (key === 'REGISTRATION_ENABLED') return Promise.resolve('true');
        if (key === 'EMAIL_VERIFICATION_ENABLED') return Promise.resolve('true');
        return Promise.resolve('false');
      });

      const result = await service.getAuthStatus();

      expect(result.registrationEnabled).toBe(true);
      expect(result.emailVerificationEnabled).toBe(true);
      expect(result.hasSuperAdmin).toBe(true);
    });
  });

  // ─── resetPassword ───────────────────────────────────────
  describe('resetPassword', () => {
    it('应成功重置密码', async () => {
      // mock validateVerificationCode to pass
      verificationCodeRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        }),
      });
      userRepo.findOne.mockResolvedValue({ id: 'u1' });
      userRepo.update.mockResolvedValue(undefined);

      await service.resetPassword(
        { email: 'test@example.com', code: '123456', newPassword: 'newpass' },
        '1.2.3.4',
      );

      expect(userRepo.update).toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'password_reset' }),
      );
    });
  });

  // ─── verifyEmail ─────────────────────────────────────────
  describe('verifyEmail', () => {
    it('应成功验证邮箱', async () => {
      verificationCodeRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        }),
      });
      userRepo.update.mockResolvedValue(undefined);

      await service.verifyEmail({ email: 'test@example.com', code: '123456' });

      expect(userRepo.update).toHaveBeenCalledWith(
        { email: 'test@example.com' },
        { emailVerified: true },
      );
    });
  });

  // ─── sendVerificationCode ────────────────────────────────
  describe('sendVerificationCode', () => {
    it('邮箱验证未开启时应抛出 BadRequestException', async () => {
      configCacheService.get.mockResolvedValue('false');

      await expect(
        service.sendVerificationCode(
          { email: 'test@example.com', type: 'register' }, '1.2.3.4',
        ),
      ).rejects.toThrow('邮箱验证码功能未开启');
    });

    it('IP 限流时应抛出 BadRequestException', async () => {
      configCacheService.get.mockResolvedValue('true');
      rateLimitService.checkAndIncrement.mockResolvedValue({
        allowed: false, waitMinutes: 1,
      });

      await expect(
        service.sendVerificationCode(
          { email: 'test@example.com', type: 'register' }, '1.2.3.4',
        ),
      ).rejects.toThrow('验证码发送过于频繁');
    });

    it('注册类型但邮箱已存在时应抛出 BadRequestException', async () => {
      configCacheService.get.mockResolvedValue('true');
      rateLimitService.checkAndIncrement.mockResolvedValue({ allowed: true });
      userRepo.findOne.mockResolvedValue({ id: 'u1' });

      await expect(
        service.sendVerificationCode(
          { email: 'test@example.com', type: 'register' }, '1.2.3.4',
        ),
      ).rejects.toThrow('当前邮箱暂无法发送验证码');
    });
  });
});
