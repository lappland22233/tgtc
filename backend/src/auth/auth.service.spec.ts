import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { User } from '../common/entities/user.entity';
import { VerificationCode } from '../common/entities/verification-code.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { JwtRevokedToken } from '../common/entities/jwt-revoked-token.entity';
import { SystemConfig } from '../common/entities/system-config.entity';
import { MailerService } from '../mailer/mailer.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { RateLimitService } from '../common/services/rate-limit.service';
import { AuditService } from '../common/services/audit.service';
import { TurnstileService } from '../common/services/turnstile.service';

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

  const mockAuditService = {
    log: jest.fn(),
  };

  beforeEach(async () => {
    process.env.CODE_HMAC_SECRET = 'test-code-hmac-secret';
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
          provide: getRepositoryToken(JwtRevokedToken),
          useValue: { upsert: jest.fn(), findOne: jest.fn() },
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
        { provide: TurnstileService, useValue: { verify: jest.fn().mockResolvedValue(true) } },
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

/**
 * 邮箱验证开关语义测试（任务 #22）：
 * - 开关关闭时注册 → 账号直接标记为已验证；
 * - 开关开启时注册行为不变（必须携带有效验证码，注册后同样为已验证，
 *   因验证码已在建号前校验并消费，邮箱所有权已被证明）；
 * - 登录拦截：开启时对未验证账号拒绝、对已验证账号放行；
 *   关闭时即使账号未验证也放行（拦截仅在开关开启时生效）。
 */
describe('AuthService - 邮箱验证开关与登录拦截', () => {
  let service: AuthService;

  const mockUserRepo = {
    findOne: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  /** login 现用 createQueryBuilder().addSelect('user.password') 显式加载密码 */
  const mockUserQuery = (user: any) => {
    (mockUserRepo.createQueryBuilder as jest.Mock).mockReturnValue({
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(user),
    });
  };

  const mockBannedIPRepo = {
    createQueryBuilder: jest.fn(),
  };

  const mockVerificationCodeRepo = {
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
  };

  const mockQueryRunnerManager = {
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockQueryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    isTransactionActive: false,
    isReleased: false,
    manager: mockQueryRunnerManager,
    query: jest.fn().mockResolvedValue([{ count: '0' }]),
  };

  const mockDataSource = {
    createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    transaction: jest.fn(async (callback: (manager: any) => Promise<void>) => callback({
      update: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockImplementation((_entity: unknown, value: object) => value),
      save: jest.fn().mockResolvedValue(undefined),
    })),
  };

  const mockConfigCacheService = {
    get: jest.fn(),
  };

  const mockJwtService = {
    sign: jest.fn().mockReturnValue('mock-token'),
  };

  const mockMailerService = {
    sendVerificationCode: jest.fn(),
  };

  const mockTurnstileService = {
    verify: jest.fn().mockResolvedValue(true),
  };

  const mockRateLimitService = {
    checkAndIncrement: jest.fn().mockResolvedValue({ allowed: true }),
    reset: jest.fn().mockResolvedValue(undefined),
  };

  const mockAuditService = {
    log: jest.fn(),
  };

  /** 注册事务走通：manager.create 透传入参、save 补 id 后返回 */
  const wireRegisterTransaction = () => {
    mockQueryRunnerManager.create.mockImplementation((_entity: unknown, dto: object) => dto);
    mockQueryRunnerManager.save.mockImplementation(async (_entity: unknown, u: object) => ({ id: 'user-1', ...u }));
  };

  /** 验证码原子校验通过（affected=1） */
  const wireValidVerificationCode = () => {
    const chain = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    mockVerificationCodeRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnValue(chain),
    });
  };

  /** 登录前置：IP 未被封禁 */
  const wireNoBannedIP = () => {
    const chain = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    mockBannedIPRepo.createQueryBuilder.mockReturnValue(chain);
  };

  beforeEach(async () => {
    process.env.CODE_HMAC_SECRET = 'test-code-hmac-secret';
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(VerificationCode), useValue: mockVerificationCodeRepo },
        { provide: getRepositoryToken(BannedIP), useValue: mockBannedIPRepo },
        { provide: getRepositoryToken(JwtRevokedToken), useValue: { upsert: jest.fn(), findOne: jest.fn() } },
        { provide: JwtService, useValue: mockJwtService },
        { provide: MailerService, useValue: mockMailerService },
        { provide: DataSource, useValue: mockDataSource },
        { provide: ConfigCacheService, useValue: mockConfigCacheService },
        { provide: RateLimitService, useValue: mockRateLimitService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: TurnstileService, useValue: mockTurnstileService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('注册路径', () => {
    it('开关关闭时注册：账号直接标记为已验证', async () => {
      mockConfigCacheService.get.mockResolvedValue('false');
      mockUserRepo.findOne.mockResolvedValue(null);
      mockUserRepo.count.mockResolvedValue(0);
      wireRegisterTransaction();

      const result = await service.register(
        { email: 'New@Example.com', password: 'password123' } as any,
        '127.0.0.1',
      );

      expect(mockQueryRunnerManager.create).toHaveBeenCalledWith(
        User,
        expect.objectContaining({
          email: 'new@example.com',
          emailVerified: true,
        }),
      );
      expect(result.user?.emailVerified).toBe(true);
      expect(result.accessToken).toBeDefined();
    });

    it('开关开启时注册缺少验证码：拒绝注册（行为不变）', async () => {
      mockConfigCacheService.get.mockImplementation(async (key: string) =>
        key === 'EMAIL_VERIFICATION_ENABLED' ? 'true' : 'false',
      );
      mockUserRepo.findOne.mockResolvedValue(null);

      await expect(
        service.register({ email: 'a@b.com', password: 'password123' } as any, '127.0.0.1'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.register({ email: 'a@b.com', password: 'password123' } as any, '127.0.0.1'),
      ).rejects.toThrow('请输入邮箱验证码');
    });

    it('开关开启时携带有效验证码注册：账号为已验证（邮箱已被验证码证明）', async () => {
      mockConfigCacheService.get.mockImplementation(async (key: string) =>
        key === 'EMAIL_VERIFICATION_ENABLED' ? 'true' : 'false',
      );
      mockUserRepo.findOne.mockResolvedValue(null);
      mockUserRepo.count.mockResolvedValue(0);
      wireValidVerificationCode();
      wireRegisterTransaction();

      const result = await service.register(
        { email: 'a@b.com', password: 'password123', code: '123456' } as any,
        '127.0.0.1',
      );

      expect(mockQueryRunnerManager.create).toHaveBeenCalledWith(
        User,
        expect.objectContaining({ emailVerified: true }),
      );
      expect(result.user?.emailVerified).toBe(true);
    });
  });

  describe('send-code Turnstile 阻断', () => {
    const configureSendCode = (turnstileEnabled: boolean) => {
      mockConfigCacheService.get.mockImplementation(async (key: string) => {
        if (key === 'EMAIL_VERIFICATION_ENABLED') return 'true';
        if (key === 'TURNSTILE_ENABLED') return String(turnstileEnabled);
        if (key === 'TURNSTILE_HOSTNAMES') return 'example.com';
        return 'false';
      });
      mockUserRepo.findOne.mockResolvedValue(null);
      mockVerificationCodeRepo.findOne.mockResolvedValue(null);
    };

    it('Turnstile 失败时不保存验证码也不发邮件', async () => {
      configureSendCode(true);
      mockTurnstileService.verify.mockResolvedValue(false);

      await expect(service.sendVerificationCode(
        { email: 'a@example.com', type: 'register', turnstileToken: 'token' } as any,
        '127.0.0.1',
      )).rejects.toThrow('安全校验失败');

      expect(mockTurnstileService.verify).toHaveBeenCalledWith('token', 'register', ['example.com']);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
      expect(mockMailerService.sendVerificationCode).not.toHaveBeenCalled();
    });

    it('Turnstile 成功后才保存验证码并发邮件', async () => {
      configureSendCode(true);
      mockTurnstileService.verify.mockResolvedValue(true);

      await service.sendVerificationCode(
        { email: 'a@example.com', type: 'register', turnstileToken: 'token' } as any,
        '127.0.0.1',
      );

      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockMailerService.sendVerificationCode).toHaveBeenCalledWith('a@example.com', expect.any(String));
    });

    it('Turnstile 关闭时不调用校验服务', async () => {
      configureSendCode(false);

      await service.sendVerificationCode(
        { email: 'a@example.com', type: 'register' } as any,
        '127.0.0.1',
      );

      expect(mockTurnstileService.verify).not.toHaveBeenCalled();
    });

    it('reset_password 不触发 Turnstile 校验', async () => {
      configureSendCode(true);
      mockUserRepo.findOne.mockResolvedValue({ id: 'u-1' });

      await service.sendVerificationCode(
        { email: 'a@example.com', type: 'reset_password' } as any,
        '127.0.0.1',
      );

      expect(mockTurnstileService.verify).not.toHaveBeenCalled();
    });
  });

  describe('登录拦截', () => {
    // 低轮数哈希仅用于单测加速，bcrypt.compare 按哈希内嵌成本计算，与 BCRYPT_ROUNDS 无关
    const passwordHash = bcrypt.hashSync('Correct#123', 4);
    const buildUser = (emailVerified: boolean) => ({
      id: 'u-1',
      email: 'user@example.com',
      password: passwordHash,
      role: 'user',
      isBanned: false,
      emailVerified,
    });

    it('开关开启时：未验证账号被拦截', async () => {
      mockConfigCacheService.get.mockImplementation(async (key: string) =>
        key === 'EMAIL_VERIFICATION_ENABLED' ? 'true' : 'false',
      );
      wireNoBannedIP();
      mockUserQuery(buildUser(false));

      await expect(
        service.login({ email: 'user@example.com', password: 'Correct#123' } as any, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.login({ email: 'user@example.com', password: 'Correct#123' } as any, '127.0.0.1'),
      ).rejects.toThrow('邮箱或密码错误');
    });

    it('开关开启时：已验证账号放行', async () => {
      mockConfigCacheService.get.mockImplementation(async (key: string) =>
        key === 'EMAIL_VERIFICATION_ENABLED' ? 'true' : 'false',
      );
      wireNoBannedIP();
      mockUserQuery(buildUser(true));
      mockUserRepo.update.mockResolvedValue({ affected: 1 });

      const result = await service.login(
        { email: 'user@example.com', password: 'Correct#123' } as any,
        '127.0.0.1',
      );

      expect(result.accessToken).toBe('mock-token');
      expect(result.user.emailVerified).toBe(true);
      expect(result.user.lastLoginAt).toBeInstanceOf(Date);
      expect(mockUserRepo.update).toHaveBeenCalledWith('u-1', expect.objectContaining({
        lastLoginIP: '127.0.0.1',
        lastLoginAt: expect.any(Date),
      }));
    });

    it('开关关闭时：未验证账号也放行（拦截仅在开关开启时生效）', async () => {
      mockConfigCacheService.get.mockResolvedValue('false');
      wireNoBannedIP();
      mockUserQuery(buildUser(false));
      mockUserRepo.update.mockResolvedValue({ affected: 1 });

      const result = await service.login(
        { email: 'user@example.com', password: 'Correct#123' } as any,
        '127.0.0.1',
      );

      expect(result.accessToken).toBe('mock-token');
    });
  });
});
