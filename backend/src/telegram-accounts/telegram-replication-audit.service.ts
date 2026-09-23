import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { DownloadCapacityState, DownloadCapacityPolicyService } from '../telegram-account-pool/download-capacity-policy.service';
import { FileCopyService } from '../telegram-account-pool/file-copy.service';
import {
  REPLICA_TARGET_CONFIG_KEY,
  REPLICA_TARGET_RANGE,
  ReplicaTargetResolver,
} from '../telegram-account-pool/replica-target.resolver';
import { TelegramAccountPoolService } from '../telegram-account-pool/telegram-account-pool.service';

/** 副本覆盖率审计的缺失样例上限 */
const MISSING_SAMPLE_LIMIT = 20;

/** 目标解析视图（管理端只读展示） */
export interface ReplicationTargetView {
  /** 配置的期望副本数（SystemConfig > env > 默认） */
  configured: number;
  configuredSource: 'system' | 'env' | 'default';
  /** 可承载副本的账号数 */
  eligibleCount: number;
  /** 最终目标：min(configured, eligibleCount) */
  effectiveTarget: number;
  degradedReason: string | null;
  /** 允许的配置区间（前端表单约束） */
  allowedRange: { min: number; max: number };
}

/** 单个 Bot 账号的副本资格与分布（脱敏） */
export interface ReplicationAccountView {
  accountId: string;
  enabled: boolean;
  storageConfigured: boolean;
  coolingDown: boolean;
  cooldownRemainingMs: number;
  consecutiveFailures: number;
  inflight: number;
  maxInflight: number;
  /** 该账号持有的 ready 副本数 */
  readyCopies: number;
  /** 是否可承载副本（enabled + storage Chat + 健康） */
  eligible: boolean;
  /** 不可承载的原因（可直接展示） */
  reasons: string[];
}

export interface ReplicationAuditReport {
  generatedAt: string;
  target: ReplicationTargetView;
  /** 账号池是否生效（未生效时下列数据仅作诊断） */
  poolActive: boolean;
  accounts: ReplicationAccountView[];
  coverage: {
    /** 本次扫描到的「有 ready 副本的逻辑文件」数 */
    scannedFiles: number;
    satisfied: number;
    unsatisfied: number;
    /** 分组扫描是否被上限截断（true 表示统计只覆盖前 N 个文件） */
    truncated: boolean;
    missingSamples: Array<{ ownerId: string; readyAccountCount: number; missing: number }>;
  };
  /** 容量策略状态（自动扩缩容）；未装配时为 null */
  capacity: DownloadCapacityState | null;
  /** 口径说明（避免把「账号数」误读成「可用容量」） */
  notes: string[];
}

/**
 * 副本扩散资格审计。
 *
 * 为什么需要：生产现象是「ready 副本长期集中在单一账号」，而面板上只看到账号数量，
 * 无法回答「为什么这个账号不能承载副本」「为什么目标 4 却只补到 2 路」。
 * 本服务把三类事实放在同一份报告里：
 * 1. 目标解析（configured / eligible / effective 与降级原因）；
 * 2. 逐账号资格（enabled、存储 Chat、冷却与健康、ready 副本数与排除原因）；
 * 3. 覆盖率（满足/未满足目标的文件数 + 缺失样例）。
 *
 * 安全：只输出账号 id 与脱敏统计，绝不返回 Token、完整 file_id 或原始地址。
 */
@Injectable()
export class TelegramReplicationAuditService {
  private readonly logger = new Logger(TelegramReplicationAuditService.name);

  constructor(
    private readonly pool: TelegramAccountPoolService,
    private readonly copies: FileCopyService,
    private readonly replicaTargets: ReplicaTargetResolver,
    private readonly configCache: ConfigCacheService,
    // 容量策略由账号池模块提供；直接构造本服务（单测）时允许缺失
    @Optional() @Inject(DownloadCapacityPolicyService)
    private readonly capacity: DownloadCapacityPolicyService | null = null,
  ) {}

  /** 完整审计报告（只读，不触发任何扩散） */
  async getReport(): Promise<ReplicationAuditReport> {
    const resolution = await this.replicaTargets.resolve();
    const poolActive = this.pool.isActive();

    // 逐账号：账号池运行态 + 该账号持有的 ready 副本数
    const readyByAccount = poolActive
      ? await this.copies.countReadyByAccount().catch(() => new Map<string, number>())
      : new Map<string, number>();
    const eligibility = new Map(
      resolution.eligibility.map((item) => [item.accountId, item]),
    );
    const accounts: ReplicationAccountView[] = this.pool.snapshot().accounts.map((account) => {
      const evaluated = eligibility.get(account.id);
      return {
        accountId: account.id,
        enabled: account.enabled,
        storageConfigured: account.storageConfigured,
        coolingDown: account.coolingDown,
        cooldownRemainingMs: account.cooldownRemainingMs,
        consecutiveFailures: account.consecutiveFailures,
        inflight: account.inflight,
        maxInflight: account.maxInflight,
        readyCopies: readyByAccount.get(account.id) ?? 0,
        eligible: evaluated?.eligible ?? false,
        reasons: evaluated?.reasons ?? [],
      };
    });

    // 覆盖率：只按站内逻辑文件（ownerType='file'）统计，Bot 直链的 fileUnique 命名空间不计入
    const coverage = poolActive
      ? await this.copies.replicationCoverage({
        ownerType: 'file',
        target: Math.max(1, resolution.effectiveTarget),
        sampleLimit: MISSING_SAMPLE_LIMIT,
      }).catch((error: unknown) => {
        this.logger.warn(`副本覆盖率统计失败（返回空统计）: ${(error as Error).message}`);
        return { scannedFiles: 0, satisfied: 0, unsatisfied: 0, truncated: false, missingSamples: [] };
      })
      : { scannedFiles: 0, satisfied: 0, unsatisfied: 0, truncated: false, missingSamples: [] };

    return {
      generatedAt: new Date().toISOString(),
      target: {
        configured: resolution.configured,
        configuredSource: resolution.configuredSource,
        eligibleCount: resolution.eligibleCount,
        effectiveTarget: resolution.effectiveTarget,
        degradedReason: resolution.degradedReason,
        allowedRange: { ...REPLICA_TARGET_RANGE },
      },
      poolActive,
      accounts,
      coverage,
      capacity: this.capacity?.getState() ?? null,
      notes: [
        '只统计「已启用 + 已配置存储 Chat + 健康」的 Bot 账号；USERbot 中继不计入 Bot ready 副本覆盖。',
        '无存储 Chat 的账号上传必然失败，不会作为扩散目标；如需纳入请先补齐存储 Chat 并启用。',
        '有效目标 = min(配置值, 可承载副本账号数)，因此「配置 4」在只有 2 个可承载账号时显示为 2。',
        '全局权重预算按有效 Bot 数自动扩缩容，与账号 maxInflight 不是同一个概念。',
      ],
    };
  }

  /** 期望副本数热更新（写入 SystemConfig，立即生效于后续扩散目标解析） */
  async setTarget(desiredReplicas: number): Promise<ReplicationTargetView> {
    const normalized = Math.floor(desiredReplicas);
    if (
      !Number.isFinite(normalized)
      || normalized < REPLICA_TARGET_RANGE.min
      || normalized > REPLICA_TARGET_RANGE.max
    ) {
      throw new BadRequestException(
        `期望副本数应在 ${REPLICA_TARGET_RANGE.min}-${REPLICA_TARGET_RANGE.max} 之间`,
      );
    }
    await this.configCache.set(
      REPLICA_TARGET_CONFIG_KEY,
      String(normalized),
      '每个逻辑文件应持有的账号副本数量目标（有效目标会按可承载账号数收敛）',
    );
    this.logger.log(`期望副本数已热更新：${normalized}`);
    const resolution = await this.replicaTargets.resolve();
    return {
      configured: resolution.configured,
      configuredSource: resolution.configuredSource,
      eligibleCount: resolution.eligibleCount,
      effectiveTarget: resolution.effectiveTarget,
      degradedReason: resolution.degradedReason,
      allowedRange: { ...REPLICA_TARGET_RANGE },
    };
  }
}
