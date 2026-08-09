import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { RateLimitService } from '../common/services/rate-limit.service';
import { ConfigCacheService } from '../common/services/config-cache.service';

/**
 * 分享链接密码服务：IP 封禁 + access JWT 签发/校验。
 *
 * 设计要点：
 * 1. 复用现有 BannedIPRepository 和 RateLimitService，与 file.service.ts 的
 *    IP 封禁机制完全共享同一张表。这样某个 IP 在文件密码页面多次输错，
 *    在分享链接页面也会被封禁（反之亦然）——这是期望行为，因为攻击者
 *    不能通过换分享链接绕过封禁。
 * 2. access JWT 5 分钟有效，签名包含 shareId，防止跨分享链接重放。
 * 3. JWT_SECRET 复用现有 env 配置，与认证 token 同密钥但 purpose 字段隔离。
 *
 * 注意：本服务与 file.service.ts 的 IP 封禁代码有重复（用于独立模块解耦）。
 * 严格保持与原实现一致的封禁阈值与时长，避免行为不一致。
 */
@Injectable()
export class SharePasswordService {
  private readonly logger = new Logger(SharePasswordService.name);

  // 复用 file.service.ts 的封禁窗口与阈值
  private readonly BAN_6H = 6 * 3600 * 1000;
  private readonly BAN_COUNT_LIMIT = 5;
  private readonly BAN_WINDOW = 3600 * 1000;
  private readonly PWD_WINDOW = 3600 * 1000;
  private readonly PRECHECK_WINDOW = 60 * 1000;
  private readonly PRECHECK_MAX_ATTEMPTS = 10;
  private readonly PRECHECK_LOCK_DURATION = 60 * 1000;

  constructor(
    @InjectRepository(BannedIP)
    private readonly bannedIPRepository: Repository<BannedIP>,
    private readonly rateLimitService: RateLimitService,
    private readonly configCacheService: ConfigCacheService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  /** 检查 IP 是否被封禁 */
  async isIPBanned(ip: string): Promise<{ banned: boolean; message?: string }> {
    const now = new Date();
    const ban = await this.bannedIPRepository
      .createQueryBuilder('bannedIP')
      .where('bannedIP.ip = :ip', { ip })
      .andWhere(
        '(bannedIP.isPermanent = true OR (bannedIP.isPermanent = false AND bannedIP.expiresAt > :now))',
        { now },
      )
      .getOne();

    if (ban) {
      const remaining = ban.isPermanent
        ? '永久'
        : Math.ceil((ban.expiresAt!.getTime() - now.getTime()) / 60000) + '分钟';
      return {
        banned: true,
        message: `该IP因多次密码错误已被封禁，剩余 ${remaining}`,
      };
    }
    return { banned: false };
  }

  /**
   * 在昂贵的 bcrypt 前按 IP 与分享 token 双维度限流。
   * 任一维度达到阈值即拒绝；数据库 UPSERT 保证多实例和并发下不能绕过。
   */
  async checkPasswordAttemptAllowed(ip: string | null, shareToken: string): Promise<boolean> {
    const keys = [`share-password:token:${shareToken}`];
    if (ip) keys.push(`share-password:ip:${ip}`);

    const results = await Promise.all(keys.map((key) => this.rateLimitService.checkAndIncrement(
      key,
      'share_password_precheck',
      this.PRECHECK_MAX_ATTEMPTS,
      this.PRECHECK_LOCK_DURATION,
      this.PRECHECK_WINDOW,
    )));
    return results.every((result) => result.allowed);
  }

  /** 记录失败的密码尝试，达到阈值触发封禁 */
  async recordFailedAttempt(ip: string): Promise<void> {
    const pwdLimitKey = `pwd:${ip}`;
    const banLimitKey = `ban:${ip}`;
    const pwdErrorLimit = await this.getPwdErrorLimit();
    const pwdBanDuration = await this.getPwdBanDuration();

    const pwdResult = await this.rateLimitService.incrementCounter(
      pwdLimitKey, 'password_error', pwdErrorLimit, this.PWD_WINDOW,
    );

    if (!pwdResult.thresholdReached) {
      return; // 未达阈值，仅记录
    }

    const banResult = await this.rateLimitService.incrementCounter(
      banLimitKey, 'ban_count', this.BAN_COUNT_LIMIT, this.BAN_WINDOW,
    );

    const now = Date.now();
    const currentBanCount = banResult.count;

    if (currentBanCount >= this.BAN_COUNT_LIMIT) {
      const expiresAt = new Date(now + this.BAN_6H);
      const reason = `分享密码错误${pwdErrorLimit}次，1小时内第${currentBanCount}次触发封禁，升级为6小时`;
      await this.bannedIPRepository.upsert(
        { ip, reason, isPermanent: false, expiresAt } as BannedIP,
        ['ip'],
      );
      await this.rateLimitService.reset(banLimitKey);
    } else {
      const expiresAt = new Date(now + pwdBanDuration);
      const reason = `分享密码错误${pwdErrorLimit}次，1小时内第${currentBanCount}次触发封禁`;
      await this.bannedIPRepository.upsert(
        { ip, reason, isPermanent: false, expiresAt } as BannedIP,
        ['ip'],
      );
    }
    await this.rateLimitService.reset(pwdLimitKey);
  }

  /**
   * 为验证通过的分享签发 access JWT，5 分钟有效。
   * payload 包含 shareId 防止跨链接重放。
   */
  async issueAccessJwt(shareId: string, passwordHash: string): Promise<string> {
    return this.jwtService.sign(
      { sid: shareId, typ: 'share-access', pv: this.passwordVersion(passwordHash) },
      { expiresIn: '5m' },
    );
  }

  /**
   * 校验 access JWT 是否有效且属于指定 shareId。
   * 失败返回 false（不抛异常，调用方按需处理）。
   */
  async verifyAccessJwt(token: string, expectedShareId: string, passwordHash: string): Promise<boolean> {
    try {
      const payload = jwt.verify(token, this.getJwtSecret()) as { sid?: string; typ?: string; pv?: string };
      return payload.typ === 'share-access'
        && payload.sid === expectedShareId
        && payload.pv === this.passwordVersion(passwordHash);
    } catch {
      return false;
    }
  }

  private passwordVersion(passwordHash: string): string {
    return crypto.createHmac('sha256', this.getJwtSecret()).update(passwordHash).digest('base64url');
  }

  private getJwtSecret(): string {
    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) {
      this.logger.error('JWT_SECRET 环境变量未配置，分享访问 JWT 无法校验');
      throw new Error('JWT_SECRET 环境变量未配置');
    }
    return secret;
  }

  private async getPwdErrorLimit(): Promise<number> {
    return Number(await this.configCacheService.get('sec_pwd_error_limit', '5')) || 5;
  }

  private async getPwdBanDuration(): Promise<number> {
    return (Number(await this.configCacheService.get('sec_pwd_ban_duration', '5')) || 5) * 60 * 1000;
  }
}
