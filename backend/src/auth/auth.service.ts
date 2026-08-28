import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { User, UserRole } from '../common/entities/user.entity';
import { VerificationCode } from '../common/entities/verification-code.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { JwtRevokedToken } from '../common/entities/jwt-revoked-token.entity';
import { MailerService } from '../mailer/mailer.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { AuditService } from '../common/services/audit.service';
import { AuditStatus } from '../common/entities/audit-log.entity';
import { RegisterDto, LoginDto, VerifyEmailDto, SendCodeDto, ResetPasswordDto } from './auth.dto';
import { RateLimitService } from '../common/services/rate-limit.service';
import { BCRYPT_ROUNDS } from '../common/constants/bcrypt';
import { TurnstileService } from '../common/services/turnstile.service';

/**
 * 占位 bcrypt 哈希：用户不存在时执行一次 dummy compare，
 * 使"用户不存在"与"用户存在"路径耗时一致，消除时序侧信道（防邮箱枚举）。
 * 模块加载时用固定密码按 BCRYPT_ROUNDS 生成一次，保证哈希结构有效且轮数与真实校验一致。
 *
 * G9-16(P2)：bcryptjs 为纯 JS 实现。此处 hashSync 是唯一真正同步阻塞事件循环的调用
 * （仅在进程启动时执行一次，成本可接受）；其余均为 async API（内部 setImmediate 让出，
 * 但 CPU 仍占用主线程）。TODO: 登录/注册高峰如需彻底避免主线程 CPU 阻塞，评估将
 * bcrypt 哈希/比对迁移至 worker_threads，或切换原生 bcrypt（需 node-gyp，未确认不擅自改）。
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-equalization-dummy', BCRYPT_ROUNDS);

/**
 * 注册"首位用户=超管"临界区使用的事务级咨询锁 key（固定值）。
 * 项目中未使用其他咨询锁，此 key 不会冲突；锁随事务结束（commit/rollback）自动释放。
 */
const REGISTRATION_ADVISORY_LOCK_KEY = 906033001;

@Injectable()
export class AuthService {
  /** 从安全配置动态读取限流阈值（热更新），不存在时回退到硬编码默认值 */
  private async getLoginMaxFailures(): Promise<number> { return Number(await this.configCacheService.get('sec_login_max_failures', '5')) || 5; }
  private async getLoginLockDuration(): Promise<number> { return (Number(await this.configCacheService.get('sec_login_lock_duration', '15')) || 15) * 60 * 1000; }
  private async getCodeMaxErrors(): Promise<number> { return Number(await this.configCacheService.get('sec_code_max_errors', '5')) || 5; }

  /** 审计中仅保留可识别但不可还原的邮箱片段，避免写入完整敏感邮箱。 */
  private maskEmail(email: string): string {
    const [localPart, domain] = email.split('@');
    if (!localPart || !domain) return '***';
    const visible = localPart.length <= 2 ? localPart.charAt(0) : localPart.slice(0, 2);
    return `${visible}***@${domain}`;
  }

  /** 验证码 HMAC 密钥（启动时解析并校验，见构造函数） */
  private readonly codeHmacSecret: string;

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(VerificationCode)
    private verificationCodeRepository: Repository<VerificationCode>,
    @InjectRepository(BannedIP)
    private bannedIPRepository: Repository<BannedIP>,
    @InjectRepository(JwtRevokedToken)
    private revokedTokenRepository: Repository<JwtRevokedToken>,
    @InjectDataSource()
    private dataSource: DataSource,
    private configCacheService: ConfigCacheService,
    private jwtService: JwtService,
    private mailerService: MailerService,
    private rateLimitService: RateLimitService,
    private auditService: AuditService,
    private turnstileService: TurnstileService,
  ) {
    // 验证码 HMAC 密钥：启动时强制校验，缺失则拒绝启动。
    // 杜绝硬编码回退密钥（旧实现回退到 'tgtc-code-hmac-default'，
    // 在两个环境变量均缺失时可被攻击者离线伪造任意验证码哈希）。
    const hmacSecret = process.env.CODE_HMAC_SECRET || process.env.JWT_SECRET;
    if (!hmacSecret) {
      throw new Error(
        'CODE_HMAC_SECRET 或 JWT_SECRET 环境变量未配置，无法安全计算验证码哈希，服务拒绝启动',
      );
    }
    this.codeHmacSecret = hmacSecret;
  }

  async register(registerDto: RegisterDto, _ip: string): Promise<{ accessToken?: string; user?: Partial<User>; needVerification?: boolean; message: string }> {
    // 邮箱规范化（小写 + 去空白），与登录查找约定保持一致，避免大小写差异导致重复账户/验证码错配
    const email = registerDto.email.toLowerCase().trim();

    const existingUser = await this.userRepository.findOne({
      where: { email },
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
      await this.validateVerificationCode(email, registerDto.code, 'register');
    }

    const hashedPassword = await bcrypt.hash(registerDto.password, BCRYPT_ROUNDS);

    // 使用事务 + 行锁确保超管角色的唯一性
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      // PostgreSQL 使用事务级咨询锁；SQLite 通过 BEGIN IMMEDIATE（驱动事务）串行化写入，
      // 不执行 PostgreSQL 专有函数，避免 SQLite 启动注册路径直接失败。
      if ((this.dataSource.options as { type?: string } | undefined)?.type === 'postgres') {
        await queryRunner.query('SELECT pg_advisory_xact_lock($1)', [REGISTRATION_ADVISORY_LOCK_KEY]);
      }
      // 取得锁后再统计用户数，保证"空表→首位超管"判定的串行化
      // G1-02：与 ORM count() 口径一致，排除软删用户（deletedAt IS NULL），
      // 避免"已软删用户仍占用首位超管名额"导致注册被误判关闭。
      const [{ count }] = await queryRunner.query(
        'SELECT COUNT(*) as count FROM "users" WHERE "deletedAt" IS NULL',
      );
      // TOCTOU 修复：锁表后再检查注册开关，防止并发请求绕过"首位用户"限制
      if (registrationEnabled !== 'true' && Number(count) > 0) {
        throw new BadRequestException('注册功能已关闭，请联系管理员');
      }
      const role = Number(count) === 0 ? UserRole.SUPER_ADMIN : UserRole.USER;

      const user = queryRunner.manager.create(User, {
        email,
        password: hashedPassword,
        role,
        // 注册验证码已在创建用户前校验并消费；启用邮箱验证时同样应直接标记为已验证，
        // 避免用户注册后因验证码已消费且无法重新申请而被锁死。
        emailVerified: true,
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
        metadata: { email: this.maskEmail(savedUser.email), role: role },
      });

      const accessToken = this.generateToken(savedUser);

      return {
        accessToken,
        user: {
          id: savedUser.id,
          email: savedUser.email,
          role: savedUser.role,
          emailVerified: savedUser.emailVerified,
          lastLoginAt: savedUser.lastLoginAt ?? null,
        },
        message: '注册成功',
      };
    } catch (error: unknown) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      // 处理唯一约束冲突（含邮箱唯一和 super_admin 角色唯一索引）
      const code = (error as { code?: string }).code;
      if (error instanceof Error && code === '23505') {
        throw new BadRequestException('该邮箱已被注册');
      }
      throw error;
    } finally {
      if (!queryRunner.isReleased) {
        await queryRunner.release();
      }
    }
  }

  async login(loginDto: LoginDto, ip: string): Promise<{ accessToken: string; user: Partial<User> }> {
    const now = new Date();

    // 检查 IP 维度的封禁（G1-01：追加 unbannedAt IS NULL，软解封后不再判封禁）
    const bannedIP = await this.bannedIPRepository
      .createQueryBuilder('bannedIP')
      .where('bannedIP.ip = :ip', { ip })
      .andWhere(
        '(bannedIP.isPermanent = true OR (bannedIP.isPermanent = false AND bannedIP.expiresAt > :now))',
        { now },
      )
      .andWhere('bannedIP.unbannedAt IS NULL')
      .getOne();

    if (bannedIP) {
      // G1-03：封禁 IP 分支在 bcrypt 前执行 dummy compare 对齐耗时，
      // 并返回与"用户不存在/密码错误"一致的文案，消除枚举 oracle。
      await bcrypt.compare(loginDto.password, DUMMY_PASSWORD_HASH);
      this.auditService.log({
        action: 'login_failed',
        userId: null,
        ip,
        metadata: {
          email: this.maskEmail(loginDto.email),
          reason: bannedIP.isPermanent ? 'IP永久封禁' : 'IP临时封禁',
        },
        status: AuditStatus.FAILURE,
      });
      throw new UnauthorizedException('邮箱或密码错误');
    }

    // 登录失败限流检查（IP + email 维度，email 小写规范化防绕过）
    const loginLimitKey = `login:${ip}:${loginDto.email.toLowerCase().trim()}`;

    const user = await this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('user.email = :email', { email: loginDto.email.toLowerCase().trim() })
      .getOne();

    if (!user) {
      // 用户不存在时执行一次 dummy bcrypt.compare，使本路径耗时与"用户存在"路径一致，
      // 消除时序侧信道（不存在 ~1ms vs 存在执行 bcrypt ~250ms），防止邮箱枚举
      await bcrypt.compare(loginDto.password, DUMMY_PASSWORD_HASH);

      const loginMaxFailures = await this.getLoginMaxFailures();
      const loginLockDuration = await this.getLoginLockDuration();
      const result = await this.rateLimitService.checkAndIncrement(
        loginLimitKey, 'login_failure',
        loginMaxFailures, loginLockDuration, loginLockDuration,
      );
      // 审计日志：登录失败（用户不存在）
      this.auditService.log({
        action: 'login_failed',
        userId: null,
        ip,
        metadata: { email: this.maskEmail(loginDto.email), reason: '用户不存在' },
        status: AuditStatus.FAILURE,
      });
      if (!result.allowed) {
        throw new UnauthorizedException(`登录失败次数过多，请 ${result.waitMinutes} 分钟后重试`);
      }
      throw new UnauthorizedException('邮箱或密码错误');
    }

    // G1-03：封禁 / 未验证邮箱在 bcrypt 前快速返回差异化文案会构成枚举 oracle。
    // 统一先执行 dummy bcrypt.compare 对齐耗时，再返回与"密码错误"一致的文案。
    if (user.isBanned) {
      await bcrypt.compare(loginDto.password, DUMMY_PASSWORD_HASH);
      this.auditService.log({
        action: 'login_failed',
        userId: user.id,
        ip,
        metadata: { email: this.maskEmail(loginDto.email), reason: '账号封禁' },
        status: AuditStatus.FAILURE,
      });
      throw new UnauthorizedException('邮箱或密码错误');
    }

    // 邮箱验证开启时，未验证用户不允许登录
    const emailVerificationEnabled = await this.getConfigValue('EMAIL_VERIFICATION_ENABLED', 'false');
    if (!user.emailVerified && emailVerificationEnabled === 'true') {
      await bcrypt.compare(loginDto.password, DUMMY_PASSWORD_HASH);
      this.auditService.log({
        action: 'login_failed',
        userId: user.id,
        ip,
        metadata: { email: this.maskEmail(loginDto.email), reason: '邮箱未验证' },
        status: AuditStatus.FAILURE,
      });
      throw new UnauthorizedException('邮箱或密码错误');
    }

    const isPasswordValid = await bcrypt.compare(loginDto.password, user.password);

    if (!isPasswordValid) {
      const loginMaxFailures2 = await this.getLoginMaxFailures();
      const loginLockDuration2 = await this.getLoginLockDuration();
      const result = await this.rateLimitService.checkAndIncrement(
        loginLimitKey, 'login_failure',
        loginMaxFailures2, loginLockDuration2, loginLockDuration2,
      );
      // 审计日志：登录失败（密码错误）
      this.auditService.log({
        action: 'login_failed',
        userId: user.id,
        ip,
        metadata: { reason: '密码错误', attempts: loginMaxFailures2 },
        status: AuditStatus.FAILURE,
      });
      if (!result.allowed) {
        throw new UnauthorizedException(`登录失败次数过多，请 ${result.waitMinutes} 分钟后重试`);
      }
      throw new UnauthorizedException('邮箱或密码错误');
    }

    // 登录成功，清除失败计数
    await this.rateLimitService.reset(loginLimitKey);

    // 仅更新登录相关字段，避免整实体 save() 在并发下覆盖其他字段的更新
    const lastLoginAt = new Date();
    await this.userRepository.update(user.id, { lastLoginIP: ip, lastLoginAt });
    user.lastLoginIP = ip;
    user.lastLoginAt = lastLoginAt;

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
        lastLoginAt: user.lastLoginAt ?? null,
      },
    };
  }

  async sendVerificationCode(sendCodeDto: SendCodeDto, ip: string): Promise<void> {
    const { type } = sendCodeDto;
    // 邮箱规范化，与注册/登录/验证保持一致，确保验证码存取命中同一邮箱键
    const email = sendCodeDto.email.toLowerCase().trim();

    // 检查是否开启邮箱验证码
    const emailVerificationEnabled = await this.getConfigValue('EMAIL_VERIFICATION_ENABLED', 'false');
    if (emailVerificationEnabled !== 'true') {
      throw new BadRequestException('邮箱验证码功能未开启');
    }

    // 注册发送验证码前必须完成 Turnstile 服务端校验；重置密码流程保持原有行为。
    if (type === 'register') {
      const turnstileEnabled = await this.getConfigValue('TURNSTILE_ENABLED', 'false');
      if (turnstileEnabled === 'true') {
        const configuredHostnames = (await this.getConfigValue('TURNSTILE_HOSTNAMES', process.env.TURNSTILE_HOSTNAMES || ''))
          .split(',')
          .map((hostname) => hostname.trim().toLowerCase())
          .filter(Boolean);
        if (!(await this.turnstileService.verify(sendCodeDto.turnstileToken, 'register', configuredHostnames))) {
          throw new BadRequestException('安全校验失败，请刷新页面后重试');
        }
      }
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
    // 统一模糊化错误响应：无论邮箱是否已注册，均返回相同文案，
    // 避免攻击者通过差异化错误消息枚举有效邮箱（保留 400 行为以维持原有限流/流程）
    if ((type === 'register' && user) || (type === 'reset_password' && !user)) {
      throw new BadRequestException('当前邮箱暂无法发送验证码，请核对邮箱后重试');
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

    // T2-5: 使用事务确保旧码标记失效和新码插入的原子性，
    // 防止并发请求在 update 和 save 之间产生两个有效验证码
    await this.dataSource.transaction(async (manager) => {
      await manager.update(VerificationCode, { email, type, isUsed: false }, { isUsed: true });
      const verificationCode = manager.create(VerificationCode, {
        email,
        code: codeHash,
        type,
        expiresAt,
      });
      await manager.save(verificationCode);
    });

    if (type === 'register' || type === 'reset_password') {
      try {
        await this.mailerService.sendVerificationCode(email, code);
        // SMTP 成功仅表示发送请求被 SMTP 接受，不代表邮件最终到达收件箱。
        this.auditService.log({
          action: 'email_verification_send',
          userId: user?.id ?? null,
          ip,
          resourceType: 'email',
          metadata: {
            type,
            recipient: this.maskEmail(email),
            result: 'send_request_accepted',
          },
          status: AuditStatus.SUCCESS,
        });
      } catch (error: unknown) {
        // 保持原错误处理，同时记录失败；审计中不写入验证码、正文或完整邮箱。
        this.auditService.log({
          action: 'email_verification_send',
          userId: user?.id ?? null,
          ip,
          resourceType: 'email',
          metadata: {
            type,
            recipient: this.maskEmail(email),
            result: 'failure',
          },
          status: AuditStatus.FAILURE,
        });
        throw error;
      }
    }
  }

  async verifyEmail(verifyEmailDto: VerifyEmailDto): Promise<void> {
    const email = verifyEmailDto.email.toLowerCase().trim();
    await this.validateVerificationCode(email, verifyEmailDto.code, 'register');

    await this.userRepository.update(
      { email },
      { emailVerified: true },
    );
  }

  async resetPassword(dto: ResetPasswordDto, ip: string): Promise<void> {
    const email = dto.email.toLowerCase().trim();
    await this.validateVerificationCode(email, dto.code, 'reset_password');

    const hashedPassword = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.userRepository.update(
      { email },
      { password: hashedPassword, passwordUpdatedAt: new Date() },
    );

    // 审计日志：密码重置
    const user = await this.userRepository.findOne({ where: { email }, select: ['id'] });
    if (user) {
      this.auditService.log({
        action: 'password_reset',
        userId: user.id,
        ip,
        resourceType: 'user',
        resourceId: user.id,
      });
    }
  }

  /** HMAC-SHA256 计算验证码哈希，防彩虹表反查（密钥启动时校验，见构造函数） */
  private hashCode(code: string): string {
    return crypto.createHmac('sha256', this.codeHmacSecret).update(code).digest('hex');
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
      const codeMaxErrors = await this.getCodeMaxErrors();
      const limitResult = await this.rateLimitService.checkAndIncrement(
        codeLimitKey, 'code_error',
        codeMaxErrors, 5 * 60 * 1000, 10 * 60 * 1000,
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
      // jti：令牌唯一标识，为后续基于黑名单的单独吊销提供基础
      jti: crypto.randomBytes(16).toString('hex'),
    };
    return this.jwtService.sign(payload);
  }

  async revokeToken(jti: string, userId: string, expiresAt: Date): Promise<void> {
    if (!jti || expiresAt.getTime() <= Date.now()) return;
    await this.revokedTokenRepository.upsert({ jti, userId, expiresAt } as JwtRevokedToken, ['jti']);
    // 主动吊销后立即在缓存中标记为已吊销，避免吊销检查缓存（最多 5s）延迟导致已登出 token 仍可用
    this.cacheRevoked(jti, true);
  }

  // G1-05：吊销检查内存 TTL 缓存。接受秒级吊销延迟（最长 REVOKE_CACHE_TTL_MS），
  // 将"每次认证的吊销表查询"从 2 次 DB 降为 1 次（仅保留 users 状态查询）。
  // 主动吊销（revokeToken）时同步失效缓存，避免正常登出后 token 在缓存期内仍可用。
  private static readonly REVOKE_CACHE_TTL_MS = 5 * 1000;
  private readonly revokedCache = new Map<string, { revoked: boolean; expiresAt: number }>();

  private cachedIsRevoked(jti: string): boolean | undefined {
    const cached = this.revokedCache.get(jti);
    if (!cached) return undefined;
    if (Date.now() > cached.expiresAt) {
      this.revokedCache.delete(jti);
      return undefined;
    }
    return cached.revoked;
  }

  private cacheRevoked(jti: string, revoked: boolean): void {
    if (this.revokedCache.size > 10_000) this.revokedCache.clear();
    this.revokedCache.set(jti, {
      revoked,
      expiresAt: Date.now() + AuthService.REVOKE_CACHE_TTL_MS,
    });
  }

  async isTokenRevoked(jti: string): Promise<boolean> {
    if (!jti) return true;
    const cached = this.cachedIsRevoked(jti);
    if (cached !== undefined) return cached;
    const token = await this.revokedTokenRepository.findOne({ where: { jti } });
    const revoked = !!token && token.expiresAt.getTime() > Date.now();
    this.cacheRevoked(jti, revoked);
    return revoked;
  }

  async validateUser(userId: string): Promise<User | null> {
    // UUID 格式校验，防止非 UUID 输入导致异常查询
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      return null;
    }
    return this.userRepository.findOne({ where: { id: userId } });
  }

  private async getConfigValue(key: string, defaultValue: string): Promise<string> {
    return this.configCacheService.get(key, defaultValue);
  }

  async getAuthStatus(): Promise<{
    registrationEnabled: boolean;
    emailVerificationEnabled: boolean;
    turnstileEnabled: boolean;
    siteKey: string;
  }> {
    const userCount = await this.userRepository.count();
    const [registrationEnabled, emailVerificationEnabled, turnstileEnabled, siteKey] = await Promise.all([
      this.getConfigValue('REGISTRATION_ENABLED', 'false'),
      this.getConfigValue('EMAIL_VERIFICATION_ENABLED', 'false'),
      this.getConfigValue('TURNSTILE_ENABLED', 'false'),
      this.getConfigValue('TURNSTILE_SITE_KEY', ''),
    ]);

    return {
      registrationEnabled: userCount === 0 || registrationEnabled === 'true',
      emailVerificationEnabled: emailVerificationEnabled === 'true',
      turnstileEnabled: turnstileEnabled === 'true',
      siteKey,
    };
  }
}