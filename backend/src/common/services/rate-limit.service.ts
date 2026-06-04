import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { RateLimit } from '../entities/rate-limit.entity';

export interface RateLimitResult {
  allowed: boolean;
  waitMinutes?: number;
}

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(
    @InjectRepository(RateLimit)
    private rateLimitRepo: Repository<RateLimit>,
  ) {}

  /**
   * 原子检查并递增限流计数。
   * 如果窗口已过期则重置；如果在锁定中则拒绝；否则递增计数并在达到阈值时锁定。
   *
   * @param key   限流键（如 login:ip:email）
   * @param type  类型标签
   * @param maxAttempts 窗口内最大尝试次数
   * @param lockDurationMs 达到阈值后的锁定时长 (ms)
   * @param windowMs  滑动窗口时长 (ms)，窗口过期自动重置
   */
  async checkAndIncrement(
    key: string,
    type: string,
    maxAttempts: number,
    lockDurationMs: number,
    windowMs: number,
  ): Promise<RateLimitResult> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMs);

    // 使用单一原子化 SQL 操作处理并发，避免竞态条件
    // 如果窗口已过期 → 重置计数为 1；否则递增计数
    // 如果已锁定 → 不更新（WHERE 条件过滤）
    const result = await this.rateLimitRepo.manager.query(
      `INSERT INTO rate_limits ("key", "type", "attemptCount", "firstAttemptAt", "lockedUntil", "updatedAt")
       VALUES ($1, $2, 1, $3, NULL, NOW())
       ON CONFLICT ("key") DO UPDATE SET
         "attemptCount" = CASE
           WHEN rate_limits."firstAttemptAt" < $4::timestamp THEN 1
           ELSE rate_limits."attemptCount" + 1
         END,
         "firstAttemptAt" = CASE
           WHEN rate_limits."firstAttemptAt" < $4::timestamp THEN $3::timestamp
           ELSE rate_limits."firstAttemptAt"
         END,
         "updatedAt" = NOW()
       WHERE rate_limits."lockedUntil" IS NULL
          OR rate_limits."lockedUntil" < NOW()
       RETURNING "attemptCount", "firstAttemptAt", "lockedUntil"`,
      [key, type, now, windowStart],
    );

    // 如果无返回行，说明记录处于锁定状态（WHERE 条件不满足）
    if (!result || result.length === 0) {
      const locked = await this.rateLimitRepo.findOne({ where: { key } });
      if (locked?.lockedUntil && now < locked.lockedUntil) {
        const waitMinutes = Math.ceil((locked.lockedUntil.getTime() - now.getTime()) / 60000);
        return { allowed: false, waitMinutes };
      }
      // 理论上不应到达，兜底拒绝
      return { allowed: false, waitMinutes: 1 };
    }

    const row = result[0];
    const count = row.attemptCount;

    // 窗口内的首次尝试，但已被 CASE 重置为 1（窗口过期场景）
    if (count === 1 && row.firstAttemptAt) {
      const firstAttemptAt = new Date(row.firstAttemptAt);
      if (now.getTime() - firstAttemptAt.getTime() < 1000) {
        // 刚刚重置，视为窗口内第一次
        return { allowed: true };
      }
    }

    // 达到阈值 → 锁定
    if (count >= maxAttempts) {
      const lockedUntil = new Date(now.getTime() + lockDurationMs);
      await this.rateLimitRepo.update({ key }, { lockedUntil });
      const waitMinutes = Math.ceil(lockDurationMs / 60000);
      return { allowed: false, waitMinutes };
    }

    return { allowed: true };
  }

  /**
   * 清除指定键的限流记录（登录/验证成功后调用）
   */
  async reset(key: string): Promise<void> {
    try {
      await this.rateLimitRepo.delete({ key });
    } catch (error: unknown) {
      this.logger.warn('重置限流记录失败', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 获取指定键的当前尝试次数
   */
  async getAttemptCount(key: string): Promise<number> {
    const record = await this.rateLimitRepo.findOne({ where: { key } });
    return record?.attemptCount ?? 0;
  }

  /**
   * 清理过期记录（定时任务调用）
   */
  async cleanupExpired(): Promise<number> {
    // 清理锁定已过期 + 窗口已过期的记录
    const cutoff = new Date(Date.now() - 60 * 60 * 1000); // 1 小时前
    const result = await this.rateLimitRepo
      .createQueryBuilder()
      .delete()
      .from(RateLimit)
      .where('"lockedUntil" IS NOT NULL AND "lockedUntil" < :now', { now: new Date() })
      .orWhere('"lockedUntil" IS NULL AND "updatedAt" < :cutoff', { cutoff })
      .execute();
    return result.affected ?? 0;
  }
}
