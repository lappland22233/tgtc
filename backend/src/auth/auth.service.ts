import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, MoreThan, DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { User, UserRole } from '../common/entities/user.entity';
import { VerificationCode } from '../common/entities/verification-code.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { MailerService } from '../mailer/mailer.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { RegisterDto, LoginDto, VerifyEmailDto, SendCodeDto, ResetPasswordDto } from './auth.dto';

// 登录失败计数器（key: ip:email, value: { count, lastAttempt }）
interface LoginFailureEntry {
  count: number;
  lastAttempt: number;
}

// 验证码错误尝试计数器（key: email:type, value: { count, lockedUntil }）
interface CodeErrorEntry {
  count: number;
  lockedUntil: number;
}

@Injectable()
export class AuthService {
  // 登录失败限流：IP + email 维度，5 次失败锁定 15 分钟
  private readonly loginFailures = new Map<string, LoginFailureEntry>();
  private readonly LOGIN_MAX_FAILURES = 5;
  private readonly LOGIN_LOCK_DURATION = 15 * 60 * 1000; // 15 分钟

  // 验证码错误尝试限流：email + type 维度，5 次错误锁定 5 分钟
  private readonly codeErrors = new Map<string, CodeErrorEntry>();
  private readonly CODE_MAX_ERRORS = 5;
  private readonly CODE_LOCK_DURATION = 5 * 60 * 1000; // 5 分钟
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(VerificationCode)
    private verificationCodeRepository: Repository<VerificationCode>,
    @InjectRepository(BannedIP)
    private bannedIPRepository: Repository<BannedIP>,
    @InjectDataSource()
    private dataSource: DataSource,
    private configCacheService: ConfigCacheService,
    private jwtService: JwtService,
    private mailerService: MailerService,
  ) {}

  async register(registerDto: RegisterDto, ip: string): Promise<{ accessToken?: string; user?: Partial<User>; needVerification?: boolean; message: string }> {
    const existingUser = await this.userRepository.findOne({
      where: { email: registerDto.email },
    });

    if (existingUser) {
      throw new BadRequestException('该邮箱已被注册');
    }

    // 检查是否允许注册（超级管理员注册后，注册功能默认关闭）
    const registrationEnabled = await this.getConfigValue('REGISTRATION_ENABLED', 'false');
    if (registrationEnabled !== 'true') {
      const userCount = await this.userRepository.count();
      if (userCount > 0) {
        throw new BadRequestException('注册功能已关闭，请联系管理员');
      }
    }

    // 检查是否需要邮箱验证码
    const emailVerificationEnabled = await this.getConfigValue('EMAIL_VERIFICATION_ENABLED', 'false');
    if (emailVerificationEnabled === 'true') {
      if (!registerDto.code) {
        throw new BadRequestException('请输入邮箱验证码');
      }
      await this.validateVerificationCode(registerDto.email, registerDto.code, 'register');
    }

    const hashedPassword = await bcrypt.hash(registerDto.password, 10);

    // 使用事务 + 行锁确保超管角色的唯一性
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 锁定 users 表防止并发注册竞态，确保首个注册用户获得 super_admin
      await queryRunner.query('LOCK TABLE "users" IN EXCLUSIVE MODE');
      const [{ count }] = await queryRunner.query(
        'SELECT COUNT(*) as count FROM "users"',
      );
      const role = Number(count) === 0 ? UserRole.SUPER_ADMIN : UserRole.USER;

      const user = queryRunner.manager.create(User, {
        email: registerDto.email,
        password: hashedPassword,
        role,
        emailVerified: emailVerificationEnabled !== 'true',
      });

      const savedUser = await queryRunner.manager.save(User, user);
      await queryRunner.commitTransaction();

      // 邮箱验证开启时不返回 token，需用户验证邮箱后再登录
      if (emailVerificationEnabled === 'true') {
        return {
          message: '注册成功，请验证邮箱',
          needVerification: true,
        };
      }

      const accessToken = this.generateToken(savedUser);

      return {
        accessToken,
        user: {
          id: savedUser.id,
          email: savedUser.email,
          role: savedUser.role,
          emailVerified: savedUser.emailVerified,
        },
        message: '注册成功',
      };
    } catch (error: unknown) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      // 处理唯一约束冲突（含邮箱唯一和 super_admin 角色唯一索引）
      if (error instanceof Error && error.message?.includes('duplicate key')) {
        throw new BadRequestException('该邮箱已被注册');
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async login(loginDto: LoginDto, ip: string): Promise<{ accessToken: string; user: Partial<User> }> {
    const now = new Date();
    const nowMs = Date.now();

    // 检查 IP 维度的封禁
    const bannedIP = await this.bannedIPRepository
      .createQueryBuilder('bannedIP')
      .where('bannedIP.ip = :ip', { ip })
      .andWhere(
        '(bannedIP.isPermanent = true OR (bannedIP.isPermanent = false AND bannedIP.expiresAt > :now))',
        { now },
      )
      .getOne();

    if (bannedIP) {
      throw new UnauthorizedException(
        bannedIP.isPermanent ? '您的IP已被永久封禁' : '您的IP已被临时封禁',
      );
    }

    // 登录失败限流检查（IP + email 维度）
    const failureKey = `${ip}:${loginDto.email}`;
    const failureEntry = this.loginFailures.get(failureKey);
    if (failureEntry && failureEntry.count >= this.LOGIN_MAX_FAILURES) {
      const lockRemaining = this.LOGIN_LOCK_DURATION - (nowMs - failureEntry.lastAttempt);
      if (lockRemaining > 0) {
        const waitMinutes = Math.ceil(lockRemaining / 60000);
        throw new UnauthorizedException(`登录失败次数过多，请 ${waitMinutes} 分钟后重试`);
      }
      // 锁定时间已过，清除计数
      this.loginFailures.delete(failureKey);
    }

    const user = await this.userRepository.findOne({
      where: { email: loginDto.email },
    });

    if (!user) {
      this.recordLoginFailure(failureKey, nowMs);
      throw new UnauthorizedException('邮箱或密码错误');
    }

    if (user.isBanned) {
      throw new UnauthorizedException('账号已被封禁');
    }

    // 邮箱验证开启时，未验证用户不允许登录
    if (!user.emailVerified) {
      const emailVerificationEnabled = await this.getConfigValue('EMAIL_VERIFICATION_ENABLED', 'false');
      if (emailVerificationEnabled === 'true') {
        throw new UnauthorizedException('请先验证邮箱');
      }
    }

    const isPasswordValid = await bcrypt.compare(loginDto.password, user.password);

    if (!isPasswordValid) {
      this.recordLoginFailure(failureKey, nowMs);
      throw new UnauthorizedException('邮箱或密码错误');
    }

    // 登录成功，清除失败计数
    this.loginFailures.delete(failureKey);

    user.lastLoginIP = ip;
    user.lastLoginAt = new Date();
    await this.userRepository.save(user);

    const accessToken = this.generateToken(user);

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        emailVerified: user.emailVerified,
      },
    };
  }

  /**
   * 记录登录失败，递增计数。失败 5 次后锁定 15 分钟。
   */
  private recordLoginFailure(key: string, nowMs: number): void {
    const entry = this.loginFailures.get(key);
    if (!entry) {
      this.loginFailures.set(key, { count: 1, lastAttempt: nowMs });
      return;
    }
    entry.count++;
    entry.lastAttempt = nowMs;
  }

  async sendVerificationCode(sendCodeDto: SendCodeDto): Promise<void> {
    const { email, type } = sendCodeDto;

    // 检查是否开启邮箱验证码
    const emailVerificationEnabled = await this.getConfigValue('EMAIL_VERIFICATION_ENABLED', 'false');
    if (emailVerificationEnabled !== 'true') {
      throw new BadRequestException('邮箱验证码功能未开启');
    }

    const user = await this.userRepository.findOne({ where: { email } });
    if (type === 'register' && user) {
      throw new BadRequestException('该邮箱已被注册');
    }
    if (type === 'reset_password' && !user) {
      throw new BadRequestException('该邮箱未注册');
    }

    // 限流检查：同一邮箱 60 秒内只能发送一次
    const recentCode = await this.verificationCodeRepository.findOne({
      where: { email, type },
      order: { createdAt: 'DESC' },
    });
    if (recentCode && (Date.now() - recentCode.createdAt.getTime()) < 60_000) {
      throw new BadRequestException('验证码发送过于频繁，请 60 秒后重试');
    }

    const code = crypto.randomInt(100000, 1000000).toString();
    const codeHash = this.hashCode(code);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await this.verificationCodeRepository.update(
      { email, type, isUsed: false },
      { isUsed: true },
    );

    const verificationCode = this.verificationCodeRepository.create({
      email,
      code: codeHash,
      type,
      expiresAt,
    });

    await this.verificationCodeRepository.save(verificationCode);

    if (type === 'register' || type === 'reset_password') {
      await this.mailerService.sendVerificationCode(email, code);
    }
  }

  async verifyEmail(verifyEmailDto: VerifyEmailDto): Promise<void> {
    await this.validateVerificationCode(verifyEmailDto.email, verifyEmailDto.code, 'register');

    await this.userRepository.update(
      { email: verifyEmailDto.email },
      { emailVerified: true },
    );
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    await this.validateVerificationCode(dto.email, dto.code, 'reset_password');

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);
    await this.userRepository.update(
      { email: dto.email },
      { password: hashedPassword },
    );
  }

  private hashCode(code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex');
  }

  protected async validateVerificationCode(email: string, code: string, type: string): Promise<void> {
    const now = new Date();
    const codeHash = this.hashCode(code);

    // 验证码错误尝试限流
    const errorKey = `${email}:${type}`;
    const errorEntry = this.codeErrors.get(errorKey);
    if (errorEntry && errorEntry.count >= this.CODE_MAX_ERRORS) {
      const nowMs = Date.now();
      if (nowMs < errorEntry.lockedUntil) {
        const waitMinutes = Math.ceil((errorEntry.lockedUntil - nowMs) / 60000);
        throw new BadRequestException(`验证码错误次数过多，请 ${waitMinutes} 分钟后重试`);
      }
      this.codeErrors.delete(errorKey);
    }

    const verificationCode = await this.verificationCodeRepository.findOne({
      where: {
        email,
        code: codeHash,
        type,
        isUsed: false,
        expiresAt: MoreThan(now),
      },
    });

    if (!verificationCode) {
      // 记录错误尝试
      const entry = this.codeErrors.get(errorKey) || { count: 0, lockedUntil: 0 };
      entry.count++;
      if (entry.count >= this.CODE_MAX_ERRORS) {
        entry.lockedUntil = Date.now() + this.CODE_LOCK_DURATION;
      }
      this.codeErrors.set(errorKey, entry);
      throw new BadRequestException('验证码无效或已过期');
    }

    // 验证成功，清除错误计数
    this.codeErrors.delete(errorKey);

    await this.verificationCodeRepository.update(
      { id: verificationCode.id },
      { isUsed: true },
    );
  }

  private generateToken(user: User): string {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    return this.jwtService.sign(payload);
  }

  async validateUser(userId: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { id: userId } });
  }

  private async getConfigValue(key: string, defaultValue: string): Promise<string> {
    return this.configCacheService.get(key, defaultValue);
  }

  async getAuthStatus(): Promise<{
    registrationEnabled: boolean;
    emailVerificationEnabled: boolean;
    hasSuperAdmin: boolean;
  }> {
    const userCount = await this.userRepository.count();
    const registrationEnabled = await this.getConfigValue('REGISTRATION_ENABLED', 'false');
    const emailVerificationEnabled = await this.getConfigValue('EMAIL_VERIFICATION_ENABLED', 'false');

    return {
      registrationEnabled: userCount === 0 || registrationEnabled === 'true',
      emailVerificationEnabled: emailVerificationEnabled === 'true',
      hasSuperAdmin: userCount > 0,
    };
  }
}
