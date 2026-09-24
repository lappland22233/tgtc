import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AuditService } from '../common/services/audit.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import {
  DOWNLOAD_CONFIG_DEFAULTS,
  DOWNLOAD_CONFIG_KEYS,
  normalizeBooleanFlag,
  normalizeDownloadConfigNumber,
} from '../file/download-resource-coordinator.service';
import { FileCopyService } from './file-copy.service';
import { ReplicaTargetResolver } from './replica-target.resolver';
import { TelegramAccountPoolService } from './telegram-account-pool.service';

/** 评估周期（毫秒）：与告警采集同量级，避免对数据库产生压力 */
export const CAPACITY_EVAL_INTERVAL_MS = 60_000;
/** 升档前的稳定周期数（目标值需连续一致） */
export const CAPACITY_UP_STABLE_CYCLES = 2;
/** 降档前的持续周期数（滞后防抖，避免账号短暂冷却导致预算抖动） */
export const CAPACITY_DOWN_STABLE_CYCLES = 10;
/** 单次升/降档幅度上限（灰度：每次最多 ±8） */
export const CAPACITY_STEP_MAX = 8;
/** 权重预算映射下限（有效 Bot 数为 1 时的目标值） */
export const CAPACITY_MIN_BUDGET = 8;
/** 权重预算映射上限（与 `DOWNLOAD_CONFIG_RANGES` 的 1-64 一致） */
export const CAPACITY_MAX_BUDGET = 64;
/** 一个评估周期内新增上游失败达到该值时冻结升档 */
export const CAPACITY_FAILURE_FREEZE_THRESHOLD = 3;
/**
 * 「高热大文件副本闸门」的大小阈值（字节）：≥1GiB 的逻辑文件参与闸门判定。
 *
 * 为什么与每账号槽位阈值（>1GiB）对齐：两者回答同一个问题——「大文件的回源
 * 压力是否已经分散到多个账号」。若闸门阈值更宽（只看 4GiB），1–4GiB 段的分卷
 * 仍可能在单账号上堆积并触发限流。
 */
export const CAPACITY_LARGE_FILE_MIN_BYTES = 1024 ** 3;
/** 大文件副本闸门要求的**最少去重账号数**：低于此值不允许升档 */
export const CAPACITY_LARGE_FILE_MIN_ACCOUNTS = 2;

/**
 * 「有效 Bot 数 → 全局上游权重预算」的容量映射。
 *
 * `min(64, max(8, activeBotCount × 8))`：1 个有效 Bot → 8；2 个 → 16；4 个 → 32。
 * 这只是容量映射，不改变 `telegram_accounts.weight` 的选号概率，
 * 也不把账号 `maxInflight` 合并成全局预算。
 */
export function targetUpstreamBudget(activeBotCount: number): number {
  const count = Number.isFinite(activeBotCount) ? Math.max(0, Math.floor(activeBotCount)) : 0;
  if (count <= 0) return CAPACITY_MIN_BUDGET;
  return Math.min(CAPACITY_MAX_BUDGET, Math.max(CAPACITY_MIN_BUDGET, count * 8));
}

/** 最近一次自动调整记录（供管理端与日志解释「预算为什么变了」） */
export interface CapacityChangeRecord {
  at: string;
  from: number;
  to: number;
  reason: string;
  activeBotCount: number;
  eligibleCount: number;
}

/** 容量策略运行状态（管理端只读） */
export interface DownloadCapacityState {
  /** 自动扩缩容开关（SystemConfig 热更新） */
  enabled: boolean;
  /** 当前生效的全局权重预算 */
  currentBudget: number;
  /** 按有效 Bot 数计算的目标预算 */
  targetBudget: number;
  /** 有效 Bot 数（enabled + storage Chat + 健康 + 已有自己的 ready 副本） */
  activeBotCount: number;
  /** 具有 storage Chat 且健康的账号数（未要求 ready 副本） */
  eligibleCount: number;
  activeBotIds: string[];
  /** 挂起自动调整的原因（无依据不缩容/未生效等） */
  suspendedReason: string | null;
  /** 本次冻结升档的原因（失败/限流闸门） */
  frozenReason: string | null;
  pendingUpCycles: number;
  pendingDownCycles: number;
  lastChange: CapacityChangeRecord | null;
  /**
   * 大文件副本闸门状态（>1GiB 逻辑文件的去重 ready 账号覆盖）。
   *
   * 意义：`activeBotCount` 只要求「账号在任意文件上有 ready 副本」，因此三个 Bot
   * 各持一个 256MiB 小文件就会让预算从 8 升到 16——而 4GB 分卷的副本可能仍然
   * 全在同一个账号上。这个闸门把「升档」与「大文件副本是否真的分散」绑定。
   */
  largeFileGate: {
    /** 参与判定的逻辑文件数（去重后；≥阈值大小且至少一条 ready 副本） */
    files: number;
    /** 覆盖最少的账号数（升档要求 ≥ 目标值） */
    minReadyAccounts: number;
    /** 要求的最少账号数 */
    requiredAccounts: number;
    /** 各文件的去重 ready 账号数（升序） */
    readyAccountCounts: number[];
    /** 统计是否被分组上限截断（true 时不允许升档） */
    truncated: boolean;
    /** 是否通过（未通过时不允许升档） */
    passed: boolean;
  } | null;
}

/**
 * 全局上游权重预算的自动扩缩容策略。
 *
 * 为什么需要：`FILE_DOWNLOAD_MAX_CONCURRENT_UPSTREAMS` 是**权重预算**，
 * 应当随「实际可回源的有效 Bot 数」扩容，而不是永久固定或手工临时调大。
 * 手工改大会在副本尚未扩散时先放大 Telegram 请求量（限流风险）。
 *
 * 闸门（全部满足才写入，写入一律审计）：
 * - `activeBotCount` 由 enabled + storage Chat + 健康（未冷却、连续失败低于阈值）
 *   + **该账号自己的 `status=ready` 副本**共同决定；
 * - `activeBotCount = 0` → 挂起自动调整（无依据不缩容）；
 * - 升档：目标值连续稳定 `CAPACITY_UP_STABLE_CYCLES` 个周期，且窗口内无新增上游失败、
 *   无账号处于限流冷却；每次最多 `+CAPACITY_STEP_MAX`；
 * - 降档：目标值持续偏低 `CAPACITY_DOWN_STABLE_CYCLES` 个周期，每次最多 `-CAPACITY_STEP_MAX`，
 *   永不低于 `CAPACITY_MIN_BUDGET`；
 * - 任何时刻都不撤销已有租约：这里只写配置，生效范围仅限后续准入。
 */
@Injectable()
export class DownloadCapacityPolicyService implements OnApplicationShutdown {
  private readonly logger = new Logger(DownloadCapacityPolicyService.name);

  private timer: NodeJS.Timeout | null = null;
  /** 当前生效的权重预算（每次评估从配置缓存刷新） */
  private currentBudget = 8;
  /** 自动扩缩容开关（每次评估从配置缓存刷新，供管理端只读展示） */
  private autoEnabled = true;
  /** 上次采样时的上游失败计数与采样时刻（用于计算「窗口内」增量） */
  private lastStreamFailures = 0;
  private lastFailureSampleAt = 0;
  private lastEvaluated = false;
  /** 最近一个采样窗口内是否达到失败冻结阈值（窗口内保持粘性，避免被即时评估稀释） */
  private frozenByFailure = false;
  private lastFailureDelta = 0;
  /** 目标值稳定轮次统计 */
  private pendingUpCycles = 0;
  private pendingDownCycles = 0;
  private lastTarget: number | null = null;
  private lastChange: CapacityChangeRecord | null = null;
  private suspendedReason: string | null = null;
  private frozenReason: string | null = null;
  private activeBotIds: string[] = [];
  private eligibleCount = 0;
  /** 大文件副本闸门状态（每次评估刷新；`null` 表示尚未评估） */
  private largeFileGate: DownloadCapacityState['largeFileGate'] = null;
  /** 并发保护：同一时刻只允许一次评估写入 */
  private evaluating = false;

  constructor(
    private readonly pool: TelegramAccountPoolService,
    private readonly copies: FileCopyService,
    private readonly replicaTargets: ReplicaTargetResolver,
    private readonly configCache: ConfigCacheService,
    private readonly audit: AuditService,
  ) {}

  /** 幂等装配周期评估（由账号池模块在启动与热开启时调用） */
  ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.evaluate().catch((error: unknown) => {
        this.logger.warn(`自动扩缩容评估失败（忽略，下轮重试）: ${(error as Error).message}`);
      });
    }, CAPACITY_EVAL_INTERVAL_MS);
    this.timer.unref?.();
    this.logger.log(
      `全局权重预算自动扩缩容已启用：每 ${CAPACITY_EVAL_INTERVAL_MS / 1000}s 评估一次`
        + `（升档需稳定 ${CAPACITY_UP_STABLE_CYCLES} 周期、降档需持续 ${CAPACITY_DOWN_STABLE_CYCLES} 周期，单次幅度 ≤${CAPACITY_STEP_MAX}）`,
    );
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 配置热更新：预算/开关变化立即重新评估（无需等待下一个周期） */
  @OnEvent('config.changed')
  async onConfigChanged(payload: { key: string; value: string }): Promise<void> {
    const watched: string[] = [
      DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS,
      DOWNLOAD_CONFIG_KEYS.AUTO_CAPACITY_ENABLED,
    ];
    if (!watched.includes(payload.key)) return;
    try {
      await this.evaluate();
    } catch (error) {
      this.logger.warn(`配置变更触发的扩缩容评估失败: ${(error as Error).message}`);
    }
  }

  /** 只读状态（管理端） */
  getState(): DownloadCapacityState {
    return {
      enabled: this.autoEnabled,
      currentBudget: this.currentBudget,
      targetBudget: targetUpstreamBudget(this.activeBotIds.length),
      activeBotCount: this.activeBotIds.length,
      eligibleCount: this.eligibleCount,
      activeBotIds: [...this.activeBotIds],
      suspendedReason: this.suspendedReason,
      frozenReason: this.frozenReason,
      pendingUpCycles: this.pendingUpCycles,
      pendingDownCycles: this.pendingDownCycles,
      lastChange: this.lastChange,
      largeFileGate: this.largeFileGate ? { ...this.largeFileGate, readyAccountCounts: [...this.largeFileGate.readyAccountCounts] } : null,
    };
  }

  /**
   * 评估一次并按闸门决定是否写入新的权重预算。
   * 定时器、配置变更事件与管理端只读查询都不会绕过这里。
   */
  async evaluate(): Promise<DownloadCapacityState> {
    if (this.evaluating) return this.getState();
    this.evaluating = true;
    try {
      const autoEnabled = normalizeBooleanFlag(
        await this.readConfig(DOWNLOAD_CONFIG_KEYS.AUTO_CAPACITY_ENABLED, DOWNLOAD_CONFIG_DEFAULTS[DOWNLOAD_CONFIG_KEYS.AUTO_CAPACITY_ENABLED]),
        DOWNLOAD_CONFIG_DEFAULTS[DOWNLOAD_CONFIG_KEYS.AUTO_CAPACITY_ENABLED] === 'true',
      );
      this.autoEnabled = autoEnabled;
      this.currentBudget = normalizeDownloadConfigNumber(
        DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS,
        await this.readConfig(DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS, DOWNLOAD_CONFIG_DEFAULTS[DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS]),
      );

      await this.refreshActiveBots();
      const target = targetUpstreamBudget(this.activeBotIds.length);
      this.frozenReason = this.evaluateFreezeReason();

      if (!autoEnabled) {
        this.suspendedReason = '自动扩缩容开关已关闭（FILE_DOWNLOAD_AUTO_CAPACITY_ENABLED=false）';
        this.resetPending();
        return this.getState();
      }
      if (!this.pool.isActive()) {
        this.suspendedReason = '账号池未生效，自动扩缩容挂起';
        this.resetPending();
        return this.getState();
      }
      if (this.activeBotIds.length === 0) {
        // 无依据不缩容：没有任何账号能实际回源时保持当前预算并记录原因
        this.suspendedReason = '没有可实际回源的有效 Bot（需 enabled + 存储 Chat + 健康 + 已有 ready 副本），自动扩缩容挂起';
        this.resetPending();
        return this.getState();
      }
      this.suspendedReason = null;

      const stable = this.lastTarget === target;
      this.pendingUpCycles = target > this.currentBudget ? (stable ? this.pendingUpCycles + 1 : 1) : 0;
      this.pendingDownCycles = target < this.currentBudget ? (stable ? this.pendingDownCycles + 1 : 1) : 0;
      this.lastTarget = target;

      if (target > this.currentBudget) {
        await this.maybeScaleUp(target);
      } else if (target < this.currentBudget) {
        await this.maybeScaleDown(target);
      }
      return this.getState();
    } finally {
      this.evaluating = false;
      this.lastEvaluated = true;
    }
  }

  /** 升档：稳定周期 + 失败闸门 + 大文件副本闸门均满足才写入，单次最多 +CAPACITY_STEP_MAX */
  private async maybeScaleUp(target: number): Promise<void> {
    if (this.frozenReason) {
      this.logger.warn(`自动扩缩容暂不升档：${this.frozenReason}`);
      return;
    }
    if (this.pendingUpCycles < CAPACITY_UP_STABLE_CYCLES) return;
    // 大文件副本闸门：预算升档意味着允许更多并发冷回源；若大文件副本仍集中在
    // 单一账号，升档只会让那个账号承受更多并发（本计划要修的就是这件事）。
    // 降档是安全方向，因此只拦升档。
    if (this.largeFileGate && !this.largeFileGate.passed) {
      this.logger.warn(
        `自动扩缩容暂不升档：大文件副本闸门未通过（${this.largeFileGate.files} 个 ≥1GiB 文件，`
        + `最少覆盖账号数 ${this.largeFileGate.minReadyAccounts} < 要求 ${this.largeFileGate.requiredAccounts}`
        + `${this.largeFileGate.truncated ? '，统计被截断' : ''}）`,
      );
      return;
    }
    const next = Math.min(target, this.currentBudget + CAPACITY_STEP_MAX);
    if (next <= this.currentBudget) return;
    await this.applyBudget(
      next,
      `有效 Bot 数 ${this.activeBotIds.length} → 目标预算 ${target}，稳定 ${this.pendingUpCycles} 个周期后升档（每次 ≤+${CAPACITY_STEP_MAX}）`,
    );
  }

  /** 降档：持续周期 + 滞后防抖，单次最多 -CAPACITY_STEP_MAX 且不低于下限 */
  private async maybeScaleDown(target: number): Promise<void> {
    if (this.pendingDownCycles < CAPACITY_DOWN_STABLE_CYCLES) return;
    const next = Math.max(CAPACITY_MIN_BUDGET, Math.max(target, this.currentBudget - CAPACITY_STEP_MAX));
    if (next >= this.currentBudget) return;
    await this.applyBudget(
      next,
      `有效 Bot 数 ${this.activeBotIds.length} → 目标预算 ${target}，持续 ${this.pendingDownCycles} 个周期偏低后降档（每次 ≤-${CAPACITY_STEP_MAX}）`,
    );
  }

  /** 写入新的权重预算并审计（只影响后续准入，不撤销已有租约） */
  private async applyBudget(next: number, reason: string): Promise<void> {
    const from = this.currentBudget;
    await this.configCache.set(
      DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS,
      String(next),
      '下载上游回源全局权重预算（按有效 Bot 数自动扩缩容）',
    );
    this.currentBudget = next;
    this.resetPending();
    this.lastChange = {
      at: new Date().toISOString(),
      from,
      to: next,
      reason,
      activeBotCount: this.activeBotIds.length,
      eligibleCount: this.eligibleCount,
    };
    this.audit.log({
      action: 'config_change',
      userId: null,
      resourceType: 'config',
      // 与人工修改同一个 resourceId：便于审计按配置键串联「谁在什么时候改成了多少」
      resourceId: DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS,
      metadata: {
        oldValue: from,
        newValue: next,
        activeBotCount: this.activeBotIds.length,
        eligibleCount: this.eligibleCount,
        reason,
        source: 'auto-capacity-policy',
      },
    });
    this.logger.log(`全局上游权重预算自动调整：${from} → ${next}（${reason}）`);
  }

  /**
   * 计算有效 Bot 集合：enabled + storage Chat + 健康（未冷却、连续失败低于阈值）
   * + 该账号存在自己的 `status=ready` 副本。
   */
  private async refreshActiveBots(): Promise<void> {
    const eligibility = this.replicaTargets.evaluateEligibility();
    this.eligibleCount = eligibility.filter((item) => item.eligible).length;
    // 账号池未生效时不做副本查询（避免无意义的全表分组）
    if (!this.pool.isActive()) {
      this.activeBotIds = [];
      this.largeFileGate = null;
      return;
    }
    const readyCounts = await this.copies.countReadyByAccount();
    this.activeBotIds = eligibility
      .filter((item) => item.eligible)
      .map((item) => item.accountId)
      .filter((accountId) => (readyCounts.get(accountId) ?? 0) > 0);
    this.largeFileGate = await this.evaluateLargeFileGate();
  }

  /**
   * 大文件副本闸门：≥1GiB 的逻辑文件是否已被**多个账号**覆盖。
   *
   * 判定口径（保守，宁可拦下升档）：
   * - 没有任何大文件 → 通过（闸门不适用于「还没有大文件」的部署）；
   * - 统计被截断 → 不通过（无法确认整体分布，不据此升档）；
   * - 存在大文件 → 要求「覆盖最少的那个文件」的去重账号数 ≥
   *   `CAPACITY_LARGE_FILE_MIN_ACCOUNTS`（默认 2）。
   *
   * 为什么用「最小值」而不是平均值：只要还有一个大文件只被单个账号持有，
   * 该文件的每次冷回源都只能压在这一个账号上——平均值会把这个尾部隐藏掉。
   */
  private async evaluateLargeFileGate(): Promise<DownloadCapacityState['largeFileGate']> {
    try {
      const distribution = await this.copies.largeFileReplicaDistribution({
        minBytes: CAPACITY_LARGE_FILE_MIN_BYTES,
      });
      const required = CAPACITY_LARGE_FILE_MIN_ACCOUNTS;
      const passed = distribution.files === 0
        || (!distribution.truncated && distribution.minReadyAccounts >= required);
      return {
        files: distribution.files,
        minReadyAccounts: distribution.minReadyAccounts,
        requiredAccounts: required,
        readyAccountCounts: distribution.readyAccountCounts,
        truncated: distribution.truncated,
        passed,
      };
    } catch (error) {
      // 统计失败时必须保守：不允许升档（避免「查不到 → 当作达标」的静默放大）
      this.logger.warn(`大文件副本闸门统计失败（视为未通过）: ${(error as Error).message}`);
      return {
        files: 0,
        minReadyAccounts: 0,
        requiredAccounts: CAPACITY_LARGE_FILE_MIN_ACCOUNTS,
        readyAccountCounts: [],
        truncated: false,
        passed: false,
      };
    }
  }

  /**
   * 升档冻结判定：窗口内新增上游流失败达到阈值，或存在账号处于限流（flood）冷却。
   * 降档不受此闸门限制（缩容是安全方向）。
   */
  private evaluateFreezeReason(): string | null {
    const counters = this.pool.countersSnapshot();
    const now = Date.now();
    if (!this.lastEvaluated) {
      this.lastStreamFailures = counters.streamFailures;
      this.lastFailureSampleAt = now;
      this.frozenByFailure = false;
      this.lastFailureDelta = 0;
    } else if (now - this.lastFailureSampleAt >= CAPACITY_EVAL_INTERVAL_MS / 2) {
      // 采样窗口按墙钟推进：配置变更触发的即时评估不会「消费」掉失败增量，
      // 否则频繁改配置会稀释升档冻结闸门（失败激增被提前清零）。
      this.lastFailureDelta = counters.streamFailures - this.lastStreamFailures;
      this.lastStreamFailures = counters.streamFailures;
      this.lastFailureSampleAt = now;
      this.frozenByFailure = this.lastFailureDelta >= CAPACITY_FAILURE_FREEZE_THRESHOLD;
    }

    if (this.frozenByFailure) {
      return `采样窗口内新增回源失败 ${this.lastFailureDelta} 次（阈值 ${CAPACITY_FAILURE_FREEZE_THRESHOLD}）`;
    }
    const flooded = this.pool.snapshot().accounts.filter(
      (account) => account.coolingDown && account.lastErrorKind === 'flood',
    );
    if (flooded.length > 0) {
      return `存在限流冷却账号（${flooded.map((account) => account.id).join(', ')}）`;
    }
    return null;
  }

  private resetPending(): void {
    this.pendingUpCycles = 0;
    this.pendingDownCycles = 0;
    this.lastTarget = targetUpstreamBudget(this.activeBotIds.length);
  }

  private async readConfig(key: string, fallback: string): Promise<string> {
    try {
      return await this.configCache.get(key, fallback);
    } catch {
      return fallback;
    }
  }
}
