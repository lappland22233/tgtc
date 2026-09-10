import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { File, FileAccessType } from '../common/entities/file.entity';
import { ShareLink, ShareTargetType } from '../common/entities/share-link.entity';
import { User } from '../common/entities/user.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { RateLimitService } from '../common/services/rate-limit.service';
import { AuditService } from '../common/services/audit.service';
import { BCRYPT_ROUNDS } from '../common/constants/bcrypt';
import { assertFileWritable } from '../common/utils/file-permissions';

/**
 * 文件访问策略与密码/IP 封禁服务（M6 拆分：从 FileService 抽出，约 270 行）。
 *
 * 职责边界（访问语义域）：
 * - 访问策略变更：公开/私有、访问次数上限、访问密码、有效期；
 * - 访问校验：密码比对、次数与时效的原子扣减；
 * - 防爆破：密码错误计数、IP 封禁与升级策略。
 *
 * 不负责：上传、删除、下载流、缩略图、分享链接生成（仍由 FileService 负责）。
 *
 * 与 FileService 的耦合约定：`updateAccessCount` 的次数上限由调用方（FileService）
 * 传入——该值来自配置热更新（FILE_ACCESS_COUNT_MAX），保持单一来源，本服务不自行读取。
 */
@Injectable()
export class FileAccessControlService {
  /** 第 5 次封禁升级为 6 小时 */
  private readonly BAN_6H = 6 * 3600 * 1000;
  /** 1 小时内被封禁 5 次触发升级 */
  private readonly BAN_COUNT_LIMIT = 5;
  /** 封禁次数统计窗口 */
  private readonly BAN_WINDOW = 3600 * 1000;
  /** 密码错误统计窗口 */
  private readonly PWD_WINDOW = 3600 * 1000;

  constructor(
    @InjectRepository(File)
    private readonly fileRepository: Repository<File>,
    @InjectRepository(BannedIP)
    private readonly bannedIPRepository: Repository<BannedIP>,
    private readonly auditService: AuditService,
    private readonly configCacheService: ConfigCacheService,
    private readonly rateLimitService: RateLimitService,
  ) {}

  // ---------- 访问策略变更 ----------

  async updateAccessType(id: string, accessType: FileAccessType, user: User): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    assertFileWritable(file, user);

    // 访问类型变更与「遗留型公开分享」撤销必须在同一事务内完成：
    // 历史缺陷是先更新文件再撤销分享，撤销失败（varchar=uuid 解析错误）会留下
    // 「文件已 private 但 legacy 直链仍可访问」的中间状态。
    let revokedLegacyShares = 0;
    await this.fileRepository.manager.transaction(async (manager) => {
      await manager.getRepository(File).update(id, { accessType });

      if (accessType === FileAccessType.PRIVATE) {
        // 纵深防御：文件转私有后，软删「遗留型」公开分享链接，
        // 防止攻击者用已知文件 ID 通过 /api/s/<fileId>/download/<fileId> 继续下载已转私有的文件。
        // 显式创建的随机 token 分享不受影响。
        //
        // 注意：legacy token 就是文件 ID 本身（36 字符 UUID 字符串）。
        // 禁止写 "token" = "targetId" —— token 是 varchar(64)、targetId 是 uuid，
        // PostgreSQL 解析期即报 operator does not exist: character varying = uuid。
        // 改为将已知文件 ID 作为参数与 token（varchar）比较，类型安全且跨库一致。
        const revokeResult = await manager
          .getRepository(ShareLink)
          .createQueryBuilder()
          .update(ShareLink)
          .set({ isDeleted: true })
          .where('"targetType" = :targetType', { targetType: ShareTargetType.FILE })
          .andWhere('"targetId" = :id', { id })
          .andWhere('"token" = :legacyToken', { legacyToken: id })
          .andWhere('"isDeleted" = false')
          .execute();
        revokedLegacyShares = revokeResult.affected ?? 0;
      }
    });

    // 审计日志：文件访问类型变更
    this.auditService.log({
      action: 'file_access_change',
      userId: user.id,
      resourceType: 'file',
      resourceId: id,
      metadata: { accessType, ...(revokedLegacyShares > 0 ? { revokedLegacyShares } : {}) },
    });
  }

  /**
   * 变更访问次数上限。
   * @param maxLimit 由宿主注入的热更新上限（FILE_ACCESS_COUNT_MAX）；<= 0 表示不限制
   */
  async updateAccessCount(
    id: string,
    maxAccessCount: number,
    user: User,
    maxLimit: number,
  ): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    assertFileWritable(file, user);

    if (maxLimit > 0 && (maxAccessCount < 1 || maxAccessCount > maxLimit)) {
      throw new BadRequestException(`访问次数必须为 1 到 ${maxLimit} 之间`);
    }

    await this.fileRepository.update(id, { maxAccessCount });

    // 审计日志：访问次数限制变更
    this.auditService.log({
      action: 'file_access_change',
      userId: user.id,
      resourceType: 'file',
      resourceId: id,
      metadata: { maxAccessCount },
    });
  }

  async setPassword(id: string, password: string, user: User): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    assertFileWritable(file, user);

    const hashedPassword = password ? await bcrypt.hash(password, BCRYPT_ROUNDS) : null;
    await this.fileRepository.update(id, { password: hashedPassword });

    // 审计日志：文件密码设置/移除
    this.auditService.log({
      action: password ? 'file_password_set' : 'file_password_remove',
      userId: user.id,
      resourceType: 'file',
      resourceId: id,
    });
  }

  async updateExpires(id: string, expiresIn: number | null, user: User): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    assertFileWritable(file, user);

    await this.fileRepository.update(id, { expiresIn, expiresStartAt: expiresIn !== null ? new Date() : null });

    // 审计日志：文件有效期设置
    this.auditService.log({
      action: 'file_expiry_set',
      userId: user.id,
      resourceType: 'file',
      resourceId: id,
      metadata: { expiresIn },
    });
  }

  // ---------- 访问校验 ----------

  async verifyPassword(id: string, password: string): Promise<boolean> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file || !file.password) {
      return true;
    }

    return bcrypt.compare(password, file.password);
  }

  /**
   * 检查文件访问约束并递增计数器，返回是否允许访问
   */
  async checkAndIncrementAccess(id: string): Promise<{ allowed: boolean; reason?: string }> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
      select: ['maxAccessCount', 'currentAccessCount', 'expiresIn', 'expiresStartAt'],
    });

    if (!file) return { allowed: false, reason: '文件不存在' };

    // 检查时效限制（用设置时间 expiresStartAt 计算过期）
    if (file.expiresIn !== null && file.expiresIn !== undefined && file.expiresStartAt) {
      const expiresAt = new Date(file.expiresStartAt.getTime() + file.expiresIn * 3600 * 1000);
      if (new Date() > expiresAt) {
        return { allowed: false, reason: '文件分享已过期' };
      }
    }

    // 检查访问次数（原子 UPDATE，防止并发超发）
    if (file.maxAccessCount > 0) {
      const result = await this.fileRepository
        .createQueryBuilder()
        .update(File)
        .set({ currentAccessCount: () => '"currentAccessCount" + 1' })
        .where('id = :id', { id })
        .andWhere('"currentAccessCount" < "maxAccessCount"')
        .andWhere('"isDeleted" = false')
        .execute();

      if (result.affected === 0) {
        return { allowed: false, reason: '文件访问次数已用尽' };
      }
    }

    return { allowed: true };
  }

  async hasPassword(id: string): Promise<boolean> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
      select: ['password'],
    });
    return !!(file && file.password);
  }

  async isPrivateFile(id: string): Promise<boolean> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
      select: ['accessType'],
    });
    return !!(file && file.accessType === FileAccessType.PRIVATE);
  }

  // ---------- 防爆破：密码错误计数与 IP 封禁 ----------

  /** 从安全配置动态读取密码错误限流阈值（热更新） */
  private async getPwdErrorLimit(): Promise<number> { return Number(await this.configCacheService.get('sec_pwd_error_limit', '5')) || 5; }
  private async getPwdBanDuration(): Promise<number> { return (Number(await this.configCacheService.get('sec_pwd_ban_duration', '5')) || 5) * 60 * 1000; }

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
   * 记录失败的密码尝试
   * 每5次错误 → 封禁1小时
   * 1小时内被封禁5次 → 升级为封禁6小时
   */
  async recordFailedPasswordAttempt(ip: string): Promise<void> {
    const pwdLimitKey = `pwd:${ip}`;
    const banLimitKey = `ban:${ip}`;
    const pwdErrorLimit = await this.getPwdErrorLimit();
    const pwdBanDuration = await this.getPwdBanDuration();

    // 密码错误计数（仅计数，不锁定——达到阈值后才触发封禁）
    const pwdResult = await this.rateLimitService.incrementCounter(
      pwdLimitKey, 'password_error', pwdErrorLimit, this.PWD_WINDOW,
    );

    // 未达到阈值，仅记录
    if (!pwdResult.thresholdReached) {
      return;
    }

    // 达到阈值，原子递增 1 小时内封禁触发次数
    const banResult = await this.rateLimitService.incrementCounter(
      banLimitKey, 'ban_count', this.BAN_COUNT_LIMIT, this.BAN_WINDOW,
    );

    const now = Date.now();
    const currentBanCount = banResult.count;

    // T3-5: 使用 UPSERT 原子化封禁记录的创建/更新，消除 findOne→save 的 TOCTOU 窗口
    if (currentBanCount >= this.BAN_COUNT_LIMIT) {
      // 连续封禁 → 升级为6小时
      const expiresAt = new Date(now + this.BAN_6H);
      const reason = `密码错误${pwdErrorLimit}次，1小时内第${currentBanCount}次触发封禁，升级为6小时`;
      await this.bannedIPRepository.upsert(
        { ip, reason, isPermanent: false, expiresAt } as BannedIP,
        ['ip'],
      );
      await this.rateLimitService.reset(banLimitKey);
    } else {
      // 首次封禁 → 动态时长
      const expiresAt = new Date(now + pwdBanDuration);
      const reason = `密码错误${pwdErrorLimit}次，1小时内第${currentBanCount}次触发封禁`;
      await this.bannedIPRepository.upsert(
        { ip, reason, isPermanent: false, expiresAt } as BannedIP,
        ['ip'],
      );
    }

    // 重置错误计数器
    await this.rateLimitService.reset(pwdLimitKey);
  }
}
