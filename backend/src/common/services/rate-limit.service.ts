import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
   * 使用单一 UPSERT（含 RETURNING）完成：计数递增 + 阈值锁定 + 窗口重置。
   * lockedUntil 通过 CASE WHEN 在 ON CONFLICT DO UPDATE 中原子化设置，
   * 消除了原 isLocked→findOne 的 TOCTOU 窗口和达到阈值后独立 UPDATE 的非原子问题。
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

    // 单一原子化 UPSERT：计数递增、窗口重置、阈值锁定均在同一个 SQL 中完成
    // lockedUntil 通过 CASE WHEN 在 DO UPDATE 中原子化计算，无需后续独立 UPDATE
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
         "lockedUntil" = CASE
           WHEN rate_limits."firstAttemptAt" < $4::timestamp THEN NULL
           WHEN rate_limits."attemptCount" + 1 >= $5 THEN NOW() + ($6 || ' milliseconds')::interval
           ELSE rate_limits."lockedUntil"
         END,
         "updatedAt" = NOW()
       WHERE rate_limits."lockedUntil" IS NULL
          OR rate_limits."lockedUntil" < NOW()
       RETURNING "attemptCount", "firstAttemptAt", "lockedUntil"`,
      [key, type, now, windowStart, maxAttempts, lockDurationMs.toString()],
    );

    // 无返回行 → 记录已被其他请求锁定（WHERE 条件过滤了锁定记录）
    // 锁定时间使用 lockDurationMs 近似（已原子化设置，无 TOCTOU）
    if (!result || result.length === 0) {
      const waitMinutes = Math.ceil((lockDurationMs || 15 * 60 * 1000) / 60000);
      return { allowed: false, waitMinutes };
    }

    const row = result[0];
    const lockedUntil = row.lockedUntil ? new Date(row.lockedUntil) : null;

    // 检测本次操作是否已达到阈值并原子化设置了锁
    if (lockedUntil && now < lockedUntil) {
      const waitMinutes = Math.ceil((lockedUntil.getTime() - now.getTime()) / 60000);
      return { allowed: false, waitMinutes };
    }

    // 重置后第一次请求（count === 1）按阈值正常判断即可：
    // 1 < maxAttempts（如 5），allowed = true 已是正确结果，无需额外宽限期逻辑。
    // 原宽限期代码会让窗口重置后短时间内无条件返回 allowed=true，
    // 可被攻击者利用窗口边界绕过限流阈值，已移除。
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
