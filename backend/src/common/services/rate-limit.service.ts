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

    // 先查询是否已有记录且处于锁定状态
    const existing = await this.rateLimitRepo.findOne({ where: { key } });

    // 窗口已过期 → 重置
    if (existing && existing.firstAttemptAt) {
      const windowExpiry = new Date(existing.firstAttemptAt.getTime() + windowMs);
      if (now > windowExpiry) {
        // 窗口过期但可能锁定未过期（锁定时间可能长于窗口）→ 仍需检查锁
        if (existing.lockedUntil && now < existing.lockedUntil) {
          const waitMinutes = Math.ceil((existing.lockedUntil.getTime() - now.getTime()) / 60000);
          return { allowed: false, waitMinutes };
        }
        // 窗口和锁都已过期，重置
        await this.rateLimitRepo.delete({ key });
      } else {
        // 窗口内，检查是否锁定
        if (existing.lockedUntil && now < existing.lockedUntil) {
          const waitMinutes = Math.ceil((existing.lockedUntil.getTime() - now.getTime()) / 60000);
          return { allowed: false, waitMinutes };
        }
      }
    }

    // 原子 upsert: 插入或更新
    try {
      await this.rateLimitRepo
        .createQueryBuilder()
        .insert()
        .into(RateLimit)
        .values({
          key,
          type,
          attemptCount: 1,
          firstAttemptAt: now,
          lockedUntil: null,
        })
        .orUpdate(['attempt_count', 'updated_at'], ['key'], {
          skipUpdateIfNoValuesChanged: true,
        })
        .execute();
    } catch {
      // 如果 upsert 失败（并发冲突），使用原始 SQL 做原子 UPDATE
    }

    // 使用原始 SQL 进行原子递增（ON CONFLICT 处理并发）
    const result = await this.rateLimitRepo.manager.query(
      `INSERT INTO rate_limits ("key", "type", "attemptCount", "firstAttemptAt", "lockedUntil", "updatedAt")
       VALUES ($1, $2, 1, $3, NULL, NOW())
       ON CONFLICT ("key") DO UPDATE SET
         "attemptCount" = rate_limits."attemptCount" + 1,
         "updatedAt" = NOW()
       WHERE rate_limits."lockedUntil" IS NULL 
          OR rate_limits."lockedUntil" < NOW()
       RETURNING "attemptCount", "firstAttemptAt", "lockedUntil"`,
      [key, type, now],
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

    // 检查窗口是否过期（原子递增用的是 INSERT 时的 firstAttemptAt）
    const firstAttemptAt = new Date(row.firstAttemptAt);
    const windowExpiry = new Date(firstAttemptAt.getTime() + windowMs);
    if (now > windowExpiry) {
      // 窗口已过期但计数被递增了（并发场景），重置并允许
      // 直接 reset 并返回允许
      await this.rateLimitRepo.delete({ key });
      return { allowed: true };
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
