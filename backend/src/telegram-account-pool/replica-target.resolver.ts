import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { TelegramAccountPoolService } from './telegram-account-pool.service';

/**
 * 期望副本数的配置键（SystemConfig，管理端可热更新）。
 *
 * 迁移说明：历史上该值只从环境变量 `TELEGRAM_POOL_TARGET_REPLICAS` 读取，
 * 且只有「Bot 公开下载」一条入口传入 `desiredReplicas`；Web 下载与镜像回源都没有传，
 * 导致同一份配置在不同入口产生不同行为。现在统一由本解析器读取：
 * **SystemConfig > 环境变量（初始值/回退）> 默认值**。
 */
export const REPLICA_TARGET_CONFIG_KEY = 'TELEGRAM_POOL_TARGET_REPLICAS';
/** 期望副本数允许区间（管理端校验与运行时规范化共用） */
export const REPLICA_TARGET_RANGE = { min: 1, max: 8 } as const;
/** 没有任何配置来源时的默认期望副本数 */
export const REPLICA_TARGET_DEFAULT = 2;
/** 连续失败达到该值即视为不健康，不参与副本目标与扩散目标 */
export const REPLICA_TARGET_MAX_CONSECUTIVE_FAILURES = 3;

/** 单个账号的可承载副本资格（含排除原因，供管理端审计与容量策略复用） */
export interface ReplicaEligibility {
  accountId: string;
  eligible: boolean;
  /** 排除原因（已本地化，直接可用于管理端展示） */
  reasons: string[];
}

export interface ReplicaTargetResolution {
  /** 配置的期望副本数 */
  configured: number;
  /** 配置来源：system=SystemConfig；env=环境变量；default=内置默认 */
  configuredSource: 'system' | 'env' | 'default';
  /** 可承载副本的账号数（enabled + storage Chat + 未冷却 + 健康） */
  eligibleCount: number;
  /** 最终目标：`min(configured, eligibleCount)` */
  effectiveTarget: number;
  /** 降级原因；未降级为 null */
  degradedReason: string | null;
  eligibleAccountIds: string[];
  /** 逐账号资格（含排除原因） */
  eligibility: ReplicaEligibility[];
}

/**
 * 统一的「期望副本数 → 有效目标」解析器。
 *
 * 为什么必须统一：副本扩散的目标数量若在不同入口各算各的，会出现
 * 「Bot 直链下载补齐了副本、Web 下载不补齐」这类长期单账号集中的现象；
 * 而 `effectiveTarget` 必须按**可承载副本的账号数**收敛，
 * 否则只有一个 eligible 账号时会假装存在 4 路副本并持续产生必败上传。
 *
 * 本解析器只做「读取与判定」，不发起任何 Telegram 请求，也不修改任何状态。
 */
@Injectable()
export class ReplicaTargetResolver {
  private readonly logger = new Logger(ReplicaTargetResolver.name);

  constructor(
    private readonly pool: TelegramAccountPoolService,
    private readonly configCache: ConfigCacheService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 解析统一副本目标。
   *
   * `eligible` 判定（四个条件全部满足）：账号 `enabled`、已配置 storage Chat、
   * 未处于冷却、连续失败次数低于阈值（健康）。
   */
  async resolve(): Promise<ReplicaTargetResolution> {
    const { configured, source } = await this.configuredTarget();
    const eligibility = this.evaluateEligibility();
    const eligibleAccountIds = eligibility.filter((item) => item.eligible).map((item) => item.accountId);
    const eligibleCount = eligibleAccountIds.length;
    const effectiveTarget = Math.min(configured, eligibleCount);

    let degradedReason: string | null = null;
    if (!this.pool.isActive()) {
      degradedReason = '账号池未生效（开关关闭或未解析到账号）';
    } else if (eligibleCount === 0) {
      degradedReason = '没有可承载副本的账号（需 enabled + 存储 Chat + 未冷却 + 健康）';
    } else if (effectiveTarget < configured) {
      degradedReason = `可承载副本的账号数（${eligibleCount}）低于配置目标（${configured}），已收敛`;
    }

    return {
      configured,
      configuredSource: source,
      eligibleCount,
      effectiveTarget,
      degradedReason,
      eligibleAccountIds,
      eligibility,
    };
  }

  /**
   * 下载入口便捷方法：返回应透传给 `openStream` 的 `desiredReplicas`。
   * 账号池未生效或没有可承载账号时返回 `undefined`，调用方保持既有行为（不触发扩散）。
   */
  async desiredReplicas(): Promise<number | undefined> {
    if (!this.pool.isActive()) return undefined;
    const { effectiveTarget } = await this.resolve();
    return effectiveTarget > 0 ? effectiveTarget : undefined;
  }

  /** 逐账号资格判定（排除原因可直接展示） */
  evaluateEligibility(): ReplicaEligibility[] {
    return this.pool.snapshot().accounts.map((account) => {
      const reasons: string[] = [];
      if (!account.enabled) reasons.push('账号已禁用');
      if (!account.storageConfigured) reasons.push('未配置存储 Chat');
      if (account.coolingDown) reasons.push(`冷却中（剩余 ${Math.ceil(account.cooldownRemainingMs / 1000)}s）`);
      if (account.consecutiveFailures >= REPLICA_TARGET_MAX_CONSECUTIVE_FAILURES) {
        reasons.push(`连续失败 ${account.consecutiveFailures} 次（健康检查未通过）`);
      }
      return { accountId: account.id, eligible: reasons.length === 0, reasons };
    });
  }

  /** 配置来源优先级：SystemConfig > env > 默认值 */
  private async configuredTarget(): Promise<{ configured: number; source: 'system' | 'env' | 'default' }> {
    const systemRaw = await this.configCache
      .get(REPLICA_TARGET_CONFIG_KEY, '')
      .catch(() => '');
    const fromSystem = this.normalizeConfigured(systemRaw);
    if (fromSystem !== null) return { configured: fromSystem, source: 'system' };
    if (systemRaw.trim() !== '') {
      this.logger.warn(
        `副本目标配置非法（${this.preview(systemRaw)}），已回退环境变量/默认值`
          + `（允许区间 ${REPLICA_TARGET_RANGE.min}-${REPLICA_TARGET_RANGE.max}）`,
      );
    }

    const fromEnv = this.normalizeConfigured(this.configService?.get<string>(REPLICA_TARGET_CONFIG_KEY));
    if (fromEnv !== null) return { configured: fromEnv, source: 'env' };

    return { configured: REPLICA_TARGET_DEFAULT, source: 'default' };
  }

  /** 规范化期望副本数：缺失/非法返回 null；越界裁剪到允许区间 */
  private normalizeConfigured(raw: string | null | undefined): number | null {
    if (raw === null || raw === undefined) return null;
    const text = String(raw).trim();
    if (text === '') return null;
    const parsed = Number(text);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    return Math.min(REPLICA_TARGET_RANGE.max, Math.max(REPLICA_TARGET_RANGE.min, parsed));
  }

  /** 日志用的短预览（配置值非敏感，仅做长度收敛） */
  private preview(value: string): string {
    const trimmed = (value || '').trim();
    return trimmed.length <= 32 ? trimmed : `${trimmed.slice(0, 32)}…`;
  }
}
