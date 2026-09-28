import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigCacheService } from '../common/services/config-cache.service';
import type { TelegramCopyOwnerType } from '../common/entities/telegram-file-copy.entity';
import {
  ReplicationAttemptStatus,
  ReplicationAttemptTrigger,
  UserRelayFailureReason,
} from '../common/entities/telegram-replication-attempt.entity';
import { DownloadCapacityState, DownloadCapacityPolicyService } from '../telegram-account-pool/download-capacity-policy.service';
import { FileCopyService } from '../telegram-account-pool/file-copy.service';
import {
  RelayCapabilityService,
  RelayCapabilitySnapshot,
  RelayPreflightReport,
} from '../telegram-account-pool/relay-capability.service';
import {
  ATTEMPT_STATUS_LABELS,
  RELAY_FAILURE_LABELS,
  ReplicationAttemptDetailView,
  ReplicationAttemptService,
  RelayMetricsView,
  isAttemptRetryable,
} from '../telegram-account-pool/replication-attempt.service';
import {
  REPLICA_TARGET_CONFIG_KEY,
  REPLICA_TARGET_RANGE,
  ReplicaTargetResolver,
} from '../telegram-account-pool/replica-target.resolver';
import { TelegramAccountPoolService } from '../telegram-account-pool/telegram-account-pool.service';

/** 副本覆盖率审计的缺失样例上限 */
const MISSING_SAMPLE_LIMIT = 20;
/** 后台「最近事件」默认返回条数 */
const RECENT_ATTEMPT_LIMIT = 50;
/** 大文件主视图的分层标签（与 `SIZE_COVERAGE_TIERS` 对齐） */
const LARGE_FILE_TIER_LABEL = '≥4GiB';
const LARGE_FILE_SECONDARY_LABEL = '1–4GiB';

/**
 * 扩散重试处理器（由镜像模块注册）。
 *
 * 为什么用回调：镜像模块依赖本模块（账号主数据），反向注入会成环。
 * 重试只做「把该文件在该镜像群上的扩散重新排队」，不新建任何执行路径。
 */
export type DiffusionRetryHandler = (input: {
  ownerType: TelegramCopyOwnerType;
  ownerId: string;
  targetChatId: string | null;
  operatorUserId: string;
}) => Promise<{ requeued: number; created: number; ruleIds: string[] }>;

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

/** 单一命名空间的覆盖率统计（站内文件 / Bot 直链的 fileUnique 各一份） */
export interface ReplicationCoverageView {
  /** 本次扫描到的「有 ready 副本的逻辑文件」数 */
  scannedFiles: number;
  satisfied: number;
  unsatisfied: number;
  /** 分组扫描是否被上限截断（true 表示统计只覆盖前 N 个文件） */
  truncated: boolean;
  missingSamples: Array<{ ownerId: string; readyAccountCount: number; missing: number }>;
}

/**
 * 按**文件大小分层**的覆盖率（与 `ReplicationCoverageView` 同口径，但分组更细）。
 *
 * 为什么两份都要：总覆盖率会被大量小文件「平均」得好看，而生产风险集中在
 * 4GB 级分卷——它们是唯一能把单个账号打到 DC-5 限流的体量。分层后
 * 「≥4GiB 一行全是 1」会直接暴露在管理端。
 */
export interface ReplicationSizeCoverageView {
  scannedFiles: number;
  truncated: boolean;
  tiers: Array<{
    label: string;
    minBytes: number;
    files: number;
    satisfied: number;
    unsatisfied: number;
    minReadyAccounts: number;
    readyAccountCounts: number[];
    missingSamples: Array<{ ownerId: string; readyAccountCount: number; missing: number }>;
  }>;
}

/**
 * 当前扩散策略（对外稳定契约）。
 *
 * 为什么要把「策略 A 已移除」写进接口而不是只写在文档里：后台与运维脚本都会读这份报告，
 * 若接口层面没有明确声明，任何看到「中继失败」的人都会下意识期待「系统会自己回退」，
 * 从而不去处理缺口。把它变成接口字段，前端就能在策略卡上把这条事实固定展示出来。
 */
export interface ReplicationStrategyView {
  /** 当前策略标识（对外稳定；新增策略必须换值而不是复用） */
  mode: 'user_relay_only';
  label: string;
  /** 策略 A（从源 Bot 下载后向目标 Bot 上传）是否已移除 */
  strategyARemoved: true;
  /** 是否可能发生文件字节的二次传输（策略 B 恒为 false） */
  byteReplicationPossible: false;
  /** 中继开关是否开启（构造期读取） */
  relayEnabledByConfig: boolean;
  /** 开关变更是否需要重启后端才生效 */
  restartRequiredForToggle: true;
  /** 中继能力快照（含未检查项，前端必须区分三态） */
  capability: RelayCapabilitySnapshot;
}

/** 大文件覆盖率的单档视图（≥4GiB 为主视觉，1–4GiB 作对照） */
export interface ReplicationLargeFileTierView {
  label: string;
  minBytes: number;
  files: number;
  satisfied: number;
  unsatisfied: number;
  /** 每个文件的 ready 账号数分布（升序；用于「负载是否均衡」的直观判断） */
  readyAccountCounts: number[];
  missingSamples: Array<{ ownerId: string; readyAccountCount: number; missing: number }>;
}

/**
 * 大文件覆盖率与负载均衡前提。
 *
 * 为什么单独成块：总覆盖率会被大量小文件「平均」得好看，而生产风险集中在 4GB 级分卷
 * ——它们是唯一能把单个账号打到 DC-5 限流的体量。这里同时给出「副本已登记」与
 * 「账号当前可调度」两个口径，避免把「登记了但账号在冷却」误读成「可以分流」。
 */
export interface ReplicationLargeFileCoverageView {
  /** 统计命名空间：Bot 直链（file_unique_id）——4GB 分卷副本分布以它为准 */
  ownerType: 'fileUnique';
  /** ≥4GiB 主视图；该档没有任何文件时为 null */
  primary: ReplicationLargeFileTierView | null;
  /** 1–4GiB 对照档；无文件时为 null */
  secondary: ReplicationLargeFileTierView | null;
  scannedFiles: number;
  truncated: boolean;
  /** 已登记 ready 副本的账号数（副本登记口径） */
  readyAccounts: number;
  /** 当前可调度的账号数（enabled + 存储 Chat + 未冷却；负载均衡的真实前提） */
  schedulableAccounts: number;
}

/** 后台时间线里的单条扩散轮次（脱敏） */
export interface ReplicationAttemptView {
  id: string;
  ownerType: TelegramCopyOwnerType;
  ownerLabel: string;
  status: ReplicationAttemptStatus;
  statusLabel: string;
  failureReason: UserRelayFailureReason | null;
  failureReasonLabel: string | null;
  failureSummary: string | null;
  retryCount: number;
  desiredCount: number;
  baselineReadyCount: number;
  readyCount: number;
  missingCount: number;
  claimedAccountIds: string[];
  relayAccountId: string | null;
  targetChatPreview: string | null;
  triggeredBy: ReplicationAttemptTrigger;
  createdAt: string;
  relayCompletedAt: string | null;
  completedAt: string | null;
  nextRetryAt: string | null;
  relayDurationMs: number | null;
  claimDurationMs: number | null;
  retryable: boolean;
}

export interface ReplicationAttemptListView {
  generatedAt: string;
  items: ReplicationAttemptView[];
  /** 是否被条数上限截断 */
  truncated: boolean;
  /** 观测是否降级（写入/读取失败时前端必须提示「观测数据不完整」） */
  observability: { degraded: boolean; reason: string | null; since: string | null; writeFailures: number };
}

export interface ReplicationAuditReport {
  generatedAt: string;
  /** 当前策略与中继能力（策略卡数据源） */
  strategy: ReplicationStrategyView;
  /** 窗口内的中继指标（指标卡数据源；持久化轮次表，不是进程内计数） */
  relayMetrics: RelayMetricsView;
  /** 大文件覆盖率与负载均衡前提 */
  largeFileCoverage: ReplicationLargeFileCoverageView;
  /** 最近扩散轮次（时间线；失败原因与处理建议由详情接口给出） */
  recentAttempts: ReplicationAttemptView[];
  /** 观测健康（降级时前端必须提示数据不完整，不得渲染成健康态） */
  observability: { degraded: boolean; reason: string | null; since: string | null; writeFailures: number };
  target: ReplicationTargetView;
  /** 账号池是否生效（未生效时下列数据仅作诊断） */
  poolActive: boolean;
  accounts: ReplicationAccountView[];
  /** 站内逻辑文件（`ownerType='file'`）的覆盖率 */
  coverage: ReplicationCoverageView;
  /**
   * Bot 直链命名空间（`ownerType='fileUnique'`）的覆盖率。
   *
   * 历史实现只统计 `file`，于是「Bot 直链的大分卷副本全在一个账号上」
   * 在管理端**完全不可见**——而那正是生产事故的位置。
   */
  botCoverage: ReplicationCoverageView;
  /** 站内逻辑文件按大小分层（`ownerType='file'`） */
  sizeCoverage: ReplicationSizeCoverageView;
  /** Bot 直链命名空间按大小分层（`ownerType='fileUnique'`）：4GB 分卷分布的主视图 */
  botSizeCoverage: ReplicationSizeCoverageView;
  /** 容量策略状态（自动扩缩容）；未装配时为 null */
  capacity: DownloadCapacityState | null;
  /** 口径说明（避免把「账号数」误读成「可用容量」） */
  notes: string[];
}

/** 空覆盖率（统计失败或账号池未生效时的占位，保持字段形状一致） */
const EMPTY_COVERAGE: ReplicationCoverageView = {
  scannedFiles: 0,
  satisfied: 0,
  unsatisfied: 0,
  truncated: false,
  missingSamples: [],
};

const EMPTY_SIZE_COVERAGE: ReplicationSizeCoverageView = {
  scannedFiles: 0,
  truncated: false,
  tiers: [],
};

/** 空指标（轮次服务未装配或统计失败时的占位；比率一律 null，不伪造 0/1） */
const EMPTY_RELAY_METRICS: RelayMetricsView = {
  windowMs: 0,
  since: new Date(0).toISOString(),
  attempts: 0,
  relaySucceeded: 0,
  relayFailed: 0,
  blocked: 0,
  succeeded: 0,
  partialSuccess: 0,
  claimTimeouts: 0,
  relaySuccessRate: null,
  claimRate: null,
  relayDurationP50Ms: null,
  relayDurationP95Ms: null,
  claimDurationP50Ms: null,
  claimDurationP95Ms: null,
  failureReasons: [],
  bytesRelayed: 0,
  sampleSufficient: false,
  truncated: false,
};

/** 空能力快照（未装配时）：全部记为「未检查」，绝不渲染成健康态 */
const EMPTY_CAPABILITY_SNAPSHOT: RelayCapabilitySnapshot = {
  relayEnabledByConfig: false,
  userClientAvailable: false,
  userClientUnavailableReason: null,
  enabledAuthorizedUserCount: 0,
  resolvedTargetChatIdPreview: null,
  sourceChatIdPreview: null,
  sourceChatReadable: 'not_checked',
  targetChatWritable: 'not_checked',
  botsCanReceiveRelay: 'not_checked',
  checkedAt: null,
  checkStatus: 'not_checked',
  notes: [],
};

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
  /** 扩散重试处理器（镜像模块启动时注册；未注册 = 镜像模块未装配） */
  private retryHandler: DiffusionRetryHandler | null = null;

  constructor(
    private readonly pool: TelegramAccountPoolService,
    private readonly copies: FileCopyService,
    private readonly replicaTargets: ReplicaTargetResolver,
    private readonly configCache: ConfigCacheService,
    // 容量策略由账号池模块提供；直接构造本服务（单测）时允许缺失
    @Optional() @Inject(DownloadCapacityPolicyService)
    private readonly capacity: DownloadCapacityPolicyService | null = null,
    // 扩散轮次（策略 B 的可观测性底座）；单测直接构造时允许缺失
    @Optional() @Inject(ReplicationAttemptService)
    private readonly attempts: ReplicationAttemptService | null = null,
    // 中继能力快照与预检；单测直接构造时允许缺失
    @Optional() @Inject(RelayCapabilityService)
    private readonly capability: RelayCapabilityService | null = null,
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

    // 覆盖率：站内逻辑文件（ownerType='file'）与 Bot 直链（ownerType='fileUnique'）**各统计一份**。
    // 历史实现只统计 file，导致「Bot 直链的大分卷副本全在一个账号上」在管理端不可见。
    const target = Math.max(1, resolution.effectiveTarget);
    // 覆盖率统计**必须显式报告失败**：返回空统计会让前端渲染成「0/0、无未达标文件」，
    // 与「统计失败」在界面上不可区分——那正是「伪造的全零健康态」。
    const fileCoverage = await this.loadCoverage('file', target);
    const botCoverageResult = await this.loadCoverage('fileUnique', target);
    const sizeCoverageResult = await this.loadSizeCoverage('file', target);
    const botSizeCoverageResult = await this.loadSizeCoverage('fileUnique', target);
    const coverage = fileCoverage.value;
    const botCoverage = botCoverageResult.value;
    const sizeCoverage = sizeCoverageResult.value;
    const botSizeCoverage = botSizeCoverageResult.value;

    // 中继指标与大文件覆盖（持久化轮次表 + 分层统计）；任一缺失都以空结构降级，绝不抛给管理端
    const relayMetrics = this.attempts
      ? await this.attempts.computeMetrics()
      : EMPTY_RELAY_METRICS;
    // 观测未装配 = 指标与事件完全不可用，必须显式降级（「看不到」不等于「健康」）
    const baseObservability = this.attempts
      ? this.attempts.getObservability()
      : { degraded: true, reason: '扩散轮次观测未装配：指标与事件不可用', since: null, writeFailures: 0 };
    const coverageFailure = fileCoverage.failure
      ?? botCoverageResult.failure
      ?? sizeCoverageResult.failure
      ?? botSizeCoverageResult.failure;
    const observability = baseObservability.degraded || !coverageFailure
      ? baseObservability
      : { ...baseObservability, degraded: true, reason: coverageFailure };
    const recent = this.attempts
      ? await this.attempts.listRecent({ limit: RECENT_ATTEMPT_LIMIT })
      : { items: [], truncated: false };
    if (this.capability) await this.capability.refreshFacts();
    const capabilitySnapshot = this.capability?.snapshot() ?? EMPTY_CAPABILITY_SNAPSHOT;
    // 缺失样例的 ownerId 必须脱敏（`fileUnique` 命名空间下它就是完整的 file_unique_id）：
    // 脱敏在组装报告前完成，保证 largeFileCoverage 也拿到脱敏后的样例。
    const maskedCoverage = this.maskCoverageSamples('file', coverage);
    const maskedBotCoverage = this.maskCoverageSamples('fileUnique', botCoverage);
    const maskedSizeCoverage = this.maskSizeCoverageSamples('file', sizeCoverage);
    const maskedBotSizeCoverage = this.maskSizeCoverageSamples('fileUnique', botSizeCoverage);
    const largeFileCoverage = this.buildLargeFileCoverage(maskedBotSizeCoverage, accounts);

    return {
      generatedAt: new Date().toISOString(),
      strategy: {
        mode: 'user_relay_only',
        label: '仅用户账号中继',
        strategyARemoved: true,
        byteReplicationPossible: false,
        relayEnabledByConfig: capabilitySnapshot.relayEnabledByConfig,
        restartRequiredForToggle: true,
        capability: capabilitySnapshot,
      },
      relayMetrics,
      largeFileCoverage,
      recentAttempts: recent.items.map((attempt) => this.toAttemptView(attempt)),
      observability,
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
      coverage: maskedCoverage,
      botCoverage: maskedBotCoverage,
      sizeCoverage: maskedSizeCoverage,
      botSizeCoverage: maskedBotSizeCoverage,
      capacity: this.capacity?.getState() ?? null,
      notes: [
        '副本扩散只保留「用户账号服务端中继」一条链路；中继失败不会发生任何字节二次传输，缺口会持续到中继恢复。',
        '中继转发成功 ≠ 副本就绪：必须有 Bot 在认领窗口内登记 ready 副本才算扩散成功。',
        'relayMetrics 来自持久化轮次表（窗口内真实事件），不是进程内计数；样本不足时比率返回 null。',
        '只统计「已启用 + 已配置存储 Chat + 健康」的 Bot 账号；USERbot 中继不计入 Bot ready 副本覆盖。',
        '无存储 Chat 的账号上传必然失败，不会作为扩散目标；如需纳入请先补齐存储 Chat 并启用。',
        '有效目标 = min(配置值, 可承载副本账号数)，因此「配置 4」在只有 2 个可承载账号时显示为 2。',
        '全局权重预算按有效 Bot 数自动扩缩容，与账号 maxInflight 不是同一个概念。',
        'botCoverage / botSizeCoverage 对应 Bot 直链（file_unique_id）命名空间：4GB 分卷的副本分布以这两项为准。',
        'largeFileCoverage 同时给出「已登记 ready 副本的账号数」与「当前可调度的账号数」：前者是历史事实，后者才是分流能力。',
        '大小分层统计按「逻辑文件 + 已知 fileSize」分组，扫描有界（truncated=true 表示未覆盖全部文件）。',
        'observability.degraded=true 表示观测写入/读取失败：此时数据不完整，不得当作健康态解读。',
      ],
    };
  }

  /**
   * 加载覆盖率，并**显式报告统计失败**。
   *
   * 为什么不直接 catch 后返回空统计：空统计在前端就是「0/0、未达标 0」，
   * 与「统计失败」不可区分——那正是「伪造的全零健康态」。失败必须进入
   * `observability.degraded`，让后台显示「观测数据不完整」。
   */
  private async loadCoverage(
    ownerType: 'file' | 'fileUnique',
    target: number,
  ): Promise<{ value: ReplicationAuditReport['coverage']; failure: string | null }> {
    if (!this.pool.isActive()) return { value: { ...EMPTY_COVERAGE }, failure: null };
    try {
      const value = await this.copies.replicationCoverage({
        ownerType,
        target,
        sampleLimit: MISSING_SAMPLE_LIMIT,
      });
      return { value, failure: null };
    } catch (error) {
      const message = this.describe(error);
      this.logger.warn(`副本覆盖率统计失败（${ownerType}，返回空统计并标记观测降级）: ${message}`);
      return {
        value: { ...EMPTY_COVERAGE },
        failure: `副本覆盖率统计失败（${ownerType}）：${message}`,
      };
    }
  }

  /** 加载并按大小分层的覆盖率（统计失败同样返回失败标记，绝不伪装成空健康态） */
  private async loadSizeCoverage(
    ownerType: 'file' | 'fileUnique',
    target: number,
  ): Promise<{ value: ReplicationAuditReport['sizeCoverage']; failure: string | null }> {
    if (!this.pool.isActive()) return { value: { ...EMPTY_SIZE_COVERAGE, tiers: [] }, failure: null };
    try {
      const result = await this.copies.replicationCoverageBySize({
        ownerType,
        target,
        sampleLimit: MISSING_SAMPLE_LIMIT,
      });
      const tiers = result.tiers.map((tier) => ({
        ...tier,
        minReadyAccounts: tier.readyAccountCounts.length > 0
          ? tier.readyAccountCounts[0]
          : 0,
      }));
      return {
        value: { scannedFiles: result.scannedFiles, truncated: result.truncated, tiers },
        failure: null,
      };
    } catch (error) {
      const message = this.describe(error);
      this.logger.warn(`分层覆盖率统计失败（${ownerType}，返回空统计并标记观测降级）: ${message}`);
      return {
        value: { ...EMPTY_SIZE_COVERAGE, tiers: [] },
        failure: `分层覆盖率统计失败（${ownerType}）：${message}`,
      };
    }
  }

  private describe(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 200);
  }

  /** 缺失样例脱敏（ownerId 在 fileUnique 命名空间下即完整 file_unique_id） */
  private maskCoverageSamples(
    ownerType: TelegramCopyOwnerType,
    view: ReplicationAuditReport['coverage'],
  ): ReplicationAuditReport['coverage'] {
    return {
      ...view,
      missingSamples: view.missingSamples.map((item) => ({
        ...item,
        ownerId: this.maskOwner(ownerType, item.ownerId),
      })),
    };
  }

  /** 分层覆盖率缺失样例脱敏（同上） */
  private maskSizeCoverageSamples(
    ownerType: TelegramCopyOwnerType,
    view: ReplicationAuditReport['sizeCoverage'],
  ): ReplicationAuditReport['sizeCoverage'] {
    return {
      ...view,
      tiers: view.tiers.map((tier) => ({
        ...tier,
        missingSamples: tier.missingSamples.map((item) => ({
          ...item,
          ownerId: this.maskOwner(ownerType, item.ownerId),
        })),
      })),
    };
  }

  /**
   * 大文件覆盖率与负载均衡前提。
   *
   * 取 Bot 直链命名空间（4GB 分卷的副本分布以它为准），把 ≥4GiB 提为主视图、
   * 1–4GiB 作对照；并同时给出「已登记 ready 副本的账号数」与「当前可调度的账号数」——
   * 副本登记是历史事实，可调度才是当前分流能力，两者混在一起会让人误判「有 4 路副本 = 能分 4 路流量」。
   */
  private buildLargeFileCoverage(
    botSizeCoverage: ReplicationSizeCoverageView,
    accounts: ReplicationAccountView[],
  ): ReplicationLargeFileCoverageView {
    const pick = (label: string): ReplicationLargeFileTierView | null => {
      const tier = botSizeCoverage.tiers.find((item) => item.label === label);
      if (!tier) return null;
      return {
        label: tier.label,
        minBytes: tier.minBytes,
        files: tier.files,
        satisfied: tier.satisfied,
        unsatisfied: tier.unsatisfied,
        readyAccountCounts: tier.readyAccountCounts,
        missingSamples: tier.missingSamples,
      };
    };
    return {
      ownerType: 'fileUnique',
      primary: pick(LARGE_FILE_TIER_LABEL),
      secondary: pick(LARGE_FILE_SECONDARY_LABEL),
      scannedFiles: botSizeCoverage.scannedFiles,
      truncated: botSizeCoverage.truncated,
      readyAccounts: accounts.filter((account) => account.readyCopies > 0).length,
      schedulableAccounts: accounts.filter((account) => account.eligible).length,
    };
  }

  /** 轮次实体 → 后台时间线视图（脱敏 + 耗时派生） */
  private toAttemptView(attempt: {
    id: string;
    ownerType: TelegramCopyOwnerType;
    ownerId: string;
    status: ReplicationAttemptStatus;
    failureReason: UserRelayFailureReason | null;
    failureSummary: string | null;
    retryCount: number;
    desiredCount: number;
    baselineReadyCount: number;
    missingCount: number;
    claimedAccountIds: string[] | null;
    relayAccountId: string | null;
    targetChatId: string | null;
    triggeredBy: ReplicationAttemptTrigger;
    createdAt: Date;
    relayCompletedAt: Date | null;
    completedAt: Date | null;
    nextRetryAt: Date | null;
    startedAt: Date | null;
  }): ReplicationAttemptView {
    const claimed = attempt.claimedAccountIds ?? [];
    return {
      id: attempt.id,
      ownerType: attempt.ownerType,
      ownerLabel: this.maskOwner(attempt.ownerType, attempt.ownerId),
      status: attempt.status,
      statusLabel: ATTEMPT_STATUS_LABELS[attempt.status],
      failureReason: attempt.failureReason,
      failureReasonLabel: attempt.failureReason ? RELAY_FAILURE_LABELS[attempt.failureReason] : null,
      failureSummary: attempt.failureSummary,
      retryCount: attempt.retryCount ?? 0,
      desiredCount: attempt.desiredCount ?? 0,
      baselineReadyCount: attempt.baselineReadyCount ?? 0,
      readyCount: claimed.length || attempt.baselineReadyCount || 0,
      missingCount: attempt.missingCount ?? 0,
      claimedAccountIds: claimed,
      relayAccountId: attempt.relayAccountId,
      targetChatPreview: this.maskChatId(attempt.targetChatId),
      triggeredBy: attempt.triggeredBy,
      createdAt: attempt.createdAt.toISOString(),
      relayCompletedAt: attempt.relayCompletedAt?.toISOString() ?? null,
      completedAt: attempt.completedAt?.toISOString() ?? null,
      nextRetryAt: attempt.nextRetryAt?.toISOString() ?? null,
      relayDurationMs: this.durationMs(attempt.startedAt, attempt.relayCompletedAt),
      claimDurationMs: this.durationMs(attempt.relayCompletedAt, attempt.completedAt),
      retryable: isAttemptRetryable(attempt.status),
    };
  }

  private durationMs(from: Date | null, to: Date | null): number | null {
    if (!from || !to) return null;
    const value = to.getTime() - from.getTime();
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  /** owner 展示标签：`fileUnique` 脱敏（不输出完整 file_unique_id） */
  private maskOwner(ownerType: TelegramCopyOwnerType, ownerId: string): string {
    const value = (ownerId || '').trim();
    if (ownerType === 'fileUnique') return value.length <= 8 ? value : `${value.slice(0, 8)}…`;
    return value.length <= 16 ? value : `${value.slice(0, 16)}…`;
  }

  /** chat id 脱敏（只保留末 4 位） */
  private maskChatId(chatId: string | null | undefined): string | null {
    const trimmed = (chatId || '').trim();
    if (!trimmed) return null;
    if (trimmed.length <= 4) return '***';
    return `***${trimmed.slice(-4)}`;
  }

  /**
   * 最近扩散轮次（可按状态/原因/owner/时间筛选）。
   *
   * 与 `getReport().recentAttempts` 的区别：这是可筛选、可指定条数的独立查询，
   * 供后台「只看认领超时」「只看某个文件」这类排障场景使用。
   */
  async listAttempts(params: {
    status?: ReplicationAttemptStatus;
    failureReason?: UserRelayFailureReason;
    ownerType?: TelegramCopyOwnerType;
    ownerId?: string;
    sinceMs?: number;
    limit?: number;
  } = {}): Promise<ReplicationAttemptListView> {
    if (!this.attempts) {
      return {
        generatedAt: new Date().toISOString(),
        items: [],
        truncated: false,
        // 未装配 = 观测不可用，必须显式降级（返回「全零健康态」会让运维误判）
        observability: {
          degraded: true,
          reason: '扩散轮次观测未装配：事件与指标不可用',
          since: null,
          writeFailures: 0,
        },
      };
    }
    const result = await this.attempts.listRecent(params);
    return {
      generatedAt: new Date().toISOString(),
      items: result.items.map((attempt) => this.toAttemptView(attempt)),
      truncated: result.truncated,
      observability: this.attempts.getObservability(),
    };
  }

  /** 单轮详情（时间线 + 为什么失败 / 影响 / 建议 / 是否可重试） */
  async getAttemptDetail(id: string): Promise<ReplicationAttemptDetailView> {
    if (!this.attempts) throw new NotFoundException('扩散轮次记录不可用（观测未装配）');
    const detail = await this.attempts.getDetail(id);
    if (!detail) throw new NotFoundException('扩散轮次不存在或已被保留期清理');
    return detail;
  }

  /**
   * 注册「扩散重试」处理器（由镜像模块启动时注入）。
   *
   * 为什么用回调而不是直接注入镜像服务：镜像模块依赖本模块（账号主数据），
   * 反向注入会成环（与账号池的探测回调同一处理方式）。未注册时重试入口会
   * 明确报错「镜像模块未装配」，而不是静默什么都不做。
   */
  registerDiffusionRetryHandler(handler: DiffusionRetryHandler): void {
    this.retryHandler = handler;
  }

  /**
   * 手动重试单轮扩散。
   *
   * 前置校验（缺一不可）：
   * 1. 轮次存在；
   * 2. 状态属于可重试集合（`retryable_failed` / `claim_timeout`）——
   *    配置类阻塞与已达标轮次不提供重试入口，否则会让管理员反复点击而问题依旧；
   * 3. 镜像模块已装配（否则无处可投递）。
   *
   * 重试**不新建执行路径**：把该文件在该镜像群上的扩散重新交给镜像任务队列
   * （终态任务重置为排队、缺失任务按当前源事实补建），因此不会产生重复消息。
   */
  async retryAttempt(id: string, operatorUserId: string): Promise<{
    attemptId: string;
    requeued: number;
    created: number;
    ruleIds: string[];
  }> {
    if (!this.attempts) throw new NotFoundException('扩散轮次记录不可用（观测未装配）');
    if (!this.retryHandler) {
      throw new BadRequestException('镜像模块未装配，无法重新排队扩散任务（请检查服务启动日志）');
    }
    const attempt = await this.attempts.findById(id);
    if (!attempt) throw new NotFoundException('扩散轮次不存在或已被保留期清理');
    if (!isAttemptRetryable(attempt.status)) {
      throw new BadRequestException(
        `当前状态「${ATTEMPT_STATUS_LABELS[attempt.status]}」不支持重试；`
        + '只有「可重试失败」「认领超时」可手动重试（配置类阻塞请先修正配置）',
      );
    }

    // 目标群必须可定位：轮次记录缺目标群（历史数据）时，若按「全部启用规则」重试，
    // 会把其它镜像群的在途/终态任务一并重排（旧 mode 任务还会被再次 blocked 空转），
    // 属于误操作面。这里明确拒绝，并指向「镜像任务列表」的按群重试入口。
    const targetChatId = (attempt.targetChatId ?? '').trim();
    if (!targetChatId) {
      throw new BadRequestException(
        '该扩散轮次记录缺少镜像群信息（历史数据），无法定位要重试的单个镜像群；'
        + '请在「镜像任务列表」中按镜像群重试对应任务',
      );
    }

    const result = await this.retryHandler({
      ownerType: attempt.ownerType,
      ownerId: attempt.ownerId,
      targetChatId,
      operatorUserId,
    });

    this.logger.log(
      `管理员 ${operatorUserId} 手动重试扩散轮次 ${attempt.id}`
      + `（${attempt.ownerType}:${this.maskOwner(attempt.ownerType, attempt.ownerId)}）→ `
      + `重置 ${result.requeued} 条 / 补建 ${result.created} 条`,
    );
    return { attemptId: attempt.id, ...result };
  }

  /**
   * 中继能力预检（**默认只读，不产生任何 Telegram 消息**）。
   *
   * 未装配能力服务时返回显式失败而不是空报告：预检的语义就是「必须给出结论」，
   * 返回空对象会让运维以为「检查通过」。
   */
  async runPreflight(params: {
    dryRun?: boolean;
    sourceChatId?: string;
    targetChatId?: string;
    testMessage?: string;
  } = {}): Promise<RelayPreflightReport> {
    if (!this.capability) {
      throw new BadRequestException('中继能力预检不可用（能力服务未装配）');
    }
    return this.capability.preflight(params);
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
