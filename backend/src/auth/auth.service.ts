import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { User, UserRole } from '../common/entities/user.entity';
import { VerificationCode } from '../common/entities/verification-code.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { MailerService } from '../mailer/mailer.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { AuditService } from '../common/services/audit.service';
import { AuditStatus } from '../common/entities/audit-log.entity';
import { RegisterDto, LoginDto, VerifyEmailDto, SendCodeDto, ResetPasswordDto } from './auth.dto';
import { RateLimitService } from '../common/services/rate-limit.service';

@Injectable()
export class AuthService {
  private readonly LOGIN_MAX_FAILURES = 5;
  private readonly LOGIN_LOCK_DURATION = 15 * 60 * 1000; // 15 分钟
  private readonly LOGIN_WINDOW = 15 * 60 * 1000; // 15 分钟窗口

  private readonly CODE_MAX_ERRORS = 5;
  private readonly CODE_LOCK_DURATION = 5 * 60 * 1000; // 5 分钟
  private readonly CODE_WINDOW = 10 * 60 * 1000; // 10 分钟窗口

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
    private rateLimitService: RateLimitService,
    private auditService: AuditService,
  ) {}

  async register(registerDto: RegisterDto, _ip: string): Promise<{ accessToken?: string; user?: Partial<User>; needVerification?: boolean; message: string }> {
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
      // 使用 FOR UPDATE 确保在 REPEATABLE READ 下也能读到最新数据
      await queryRunner.query('LOCK TABLE "users" IN EXCLUSIVE MODE');
      const [{ count }] = await queryRunner.query(
        'SELECT COUNT(*) as count FROM "users" FOR UPDATE',
      );
      const role = Number(count) === 0 ? UserRole.SUPER_ADMIN : UserRole.USER;

      const user = queryRunner.manager.create(User, {
        email: registerDto.email,
        password: hashedPassword,
        role,
        // 邮箱验证关闭时直接标记为已验证，未来启用验证时存量用户可正常使用
        emailVerified: emailVerificationEnabled !== 'true',
      });

      const savedUser = await queryRunner.manager.save(User, user);
      await queryRunner.commitTransaction();

      // 审计日志：注册
      this.auditService.log({
        action: 'register',
        userId: savedUser.id,
        ip: _ip,
        resourceType: 'user',
        resourceId: savedUser.id,
        metadata: { email: savedUser.email, role: role },
      });

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

    // 登录失败限流检查（IP + email 维度，数据库持久化）
    const loginLimitKey = `login:${ip}:${loginDto.email}`;

    const user = await this.userRepository.findOne({
      where: { email: loginDto.email },
    });

    if (!user) {
      const result = await this.rateLimitService.checkAndIncrement(
        loginLimitKey, 'login_failure',
        this.LOGIN_MAX_FAILURES, this.LOGIN_LOCK_DURATION, this.LOGIN_WINDOW,
      );
      // 审计日志：登录失败（用户不存在）
      this.auditService.log({
        action: 'login_failed',
        userId: null,
        ip,
        metadata: { email: loginDto.email, reason: '用户不存在' },
        status: AuditStatus.FAILURE,
      });
      if (!result.allowed) {
        throw new UnauthorizedException(`登录失败次数过多，请 ${result.waitMinutes} 分钟后重试`);
      }
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
      const result = await this.rateLimitService.checkAndIncrement(
        loginLimitKey, 'login_failure',
        this.LOGIN_MAX_FAILURES, this.LOGIN_LOCK_DURATION, this.LOGIN_WINDOW,
      );
      // 审计日志：登录失败（密码错误）
      this.auditService.log({
        action: 'login_failed',
        userId: user.id,
        ip,
        metadata: { reason: '密码错误', attempts: this.LOGIN_MAX_FAILURES },
        status: AuditStatus.FAILURE,
      });
      if (!result.allowed) {
        throw new UnauthorizedException(`登录失败次数过多，请 ${result.waitMinutes} 分钟后重试`);
      }
      throw new UnauthorizedException('邮箱或密码错误');
    }

    // 登录成功，清除失败计数
    await this.rateLimitService.reset(loginLimitKey);

    user.lastLoginIP = ip;
    user.lastLoginAt = new Date();
    await this.userRepository.save(user);

    const accessToken = this.generateToken(user);

    // 审计日志：登录成功
    this.auditService.log({
      action: 'login',
      userId: user.id,
      ip,
    });

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

  async sendVerificationCode(sendCodeDto: SendCodeDto, ip: string): Promise<void> {
    const { email, type } = sendCodeDto;

    // 检查是否开启邮箱验证码
    const emailVerificationEnabled = await this.getConfigValue('EMAIL_VERIFICATION_ENABLED', 'false');
    if (emailVerificationEnabled !== 'true') {
      throw new BadRequestException('邮箱验证码功能未开启');
    }

    // B-5: IP 维度全局限流（3次/60秒）
    const ipLimitKey = `send-code:ip:${ip}`;
    const ipCheck = await this.rateLimitService.checkAndIncrement(
      ipLimitKey,
      'send_code_ip',
      3,
      60 * 1000,
      60 * 1000,
    );
    if (!ipCheck.allowed) {
      throw new BadRequestException(
        `验证码发送过于频繁，请 ${ipCheck.waitMinutes} 分钟后重试`,
      );
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

    // 审计日志：密码重置
    const user = await this.userRepository.findOne({ where: { email: dto.email }, select: ['id'] });
    if (user) {
      this.auditService.log({
        action: 'password_reset',
        userId: user.id,
        ip: null,
        resourceType: 'user',
        resourceId: user.id,
      });
    }
  }

  private hashCode(code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex');
  }

  protected async validateVerificationCode(email: string, code: string, type: string): Promise<void> {
    const now = new Date();
    const codeHash = this.hashCode(code);

    // 使用原子 UPDATE 查询 + 标记，防止并发的竞态条件
    const result = await this.verificationCodeRepository
      .createQueryBuilder()
      .update(VerificationCode)
      .set({ isUsed: true })
      .where('email = :email', { email })
      .andWhere('code = :code', { code: codeHash })
      .andWhere('type = :type', { type })
      .andWhere('isUsed = false')
      .andWhere('expiresAt > :now', { now })
      .execute();

    if (!result.affected || result.affected === 0) {
      // 验证码无效时才进行限流检查（避免攻击者耗尽正常用户配额）
      const codeLimitKey = `code:${email}:${type}`;
      const limitResult = await this.rateLimitService.checkAndIncrement(
        codeLimitKey, 'code_error',
        this.CODE_MAX_ERRORS, this.CODE_LOCK_DURATION, this.CODE_WINDOW,
      );
      if (!limitResult.allowed) {
        throw new BadRequestException(`验证码错误次数过多，请 ${limitResult.waitMinutes} 分钟后重试`);
      }
      throw new BadRequestException('验证码无效或已过期');
    }

    // 验证成功，清除错误计数
    const codeLimitKey = `code:${email}:${type}`;
    await this.rateLimitService.reset(codeLimitKey);
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