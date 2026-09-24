import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, MoreThan, Repository } from 'typeorm';
import type { TelegramCopyOwnerType } from '../common/entities/telegram-file-copy.entity';
import {
  ReplicationAttemptStatus,
  ReplicationAttemptTrigger,
  TelegramReplicationAttempt,
  UserRelayFailureReason,
} from '../common/entities/telegram-replication-attempt.entity';

/**
 * 同一逻辑文件的重复阻塞/失败轮次在该窗口内**合并到既有行**（累加 `retryCount`）。
 *
 * 为什么需要：下载期懒扩散是高频触发（每次未达标文件的下载都会触发一轮），
 * 若每轮都插一行，`telegram_replication_attempts` 会被同一批文件刷爆，
 * 既拖慢查询又让「最近事件」时间线全是同一条。
 */
export const ATTEMPT_MERGE_WINDOW_MS = 15 * 60 * 1000; // 预发布压测后冻结

/**
 * 新建轮次时继承 `retryCount` 的窗口（仅对可重试失败链生效）。
 *
 * 为什么需要：退避重试的间隔累加后可能超过合并窗口，若新建行时把计数清零，
 * 「指数退避 + 上限后升级人工处理」的保护就永远触发不了（表现为无限重试）。
 */
export const RETRY_COUNT_INHERIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 预发布压测后冻结

/**
 * **不允许懒触发自动重开**的阻塞终态。
 *
 * 为什么只有它：`blocked_manual`（权限不足 / 认证失效 / 可重试次数耗尽）再往下走
 * 会**真实调用 Telegram**——懒扩散是高频触发，反复重开既污染 `relayAttempts` 计数，
 * 也可能被 Flood 限制放大；必须由管理员在时间线显式重试（`force=true`）。
 *
 * 其余配置类阻塞（开关 / 目标群 / 账号 / 源锚点）保留合并语义：重开只跑前置校验、
 * 不产生任何 Telegram 调用，运维修好配置后无需逐条点重试。
 */
const NON_REOPENABLE_BLOCKED_STATUS: ReplicationAttemptStatus = 'blocked_manual';

/** 指数退避：基数 30s、倍率 2、上限 15min（预发布压测后冻结） */
export const RETRY_BACKOFF_BASE_MS = 30_000;
export const RETRY_BACKOFF_FACTOR = 2;
export const RETRY_BACKOFF_MAX_MS = 15 * 60 * 1000;
/** 连续可重试失败达到该次数后升级为 `blocked_manual`（需要人工处理，不再自动重试） */
export const RETRY_MAX_ATTEMPTS = 5; // 预发布压测后冻结

/** 指标计算单次拉取的最大行数（超出即截断，避免把全表拉进内存） */
export const METRICS_MAX_ROWS = 5000;
/** 低样本阈值：低于该样本量时不下成功率结论（前端展示「样本不足」） */
export const METRICS_MIN_SAMPLES = 5;
/** 失败摘要长度上限（脱敏后仍要收敛，避免异常文本灌满列） */
export const FAILURE_SUMMARY_LIMIT = 500;
/** 默认指标窗口（24h：与「后台必须能支撑 24 小时排障」的运营要求对齐） */
export const METRICS_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 进行中的轮次状态（同一 owner 只允许一轮在途） */
export const ATTEMPT_ACTIVE_STATUSES: ReplicationAttemptStatus[] = [
  'planned',
  'relay_running',
  'waiting_claims',
];
/** 终态（写入即不再变更，除非手动重试另起一行） */
export const ATTEMPT_TERMINAL_STATUSES: ReplicationAttemptStatus[] = [
  'succeeded',
  'partial_success',
  'claim_timeout',
  'retryable_failed',
  'blocked_manual',
  'blocked_not_configured',
  'blocked_user_client',
  'blocked_no_user_account',
  'blocked_source_anchor',
  'blocked_target_chat',
];
/** 阻塞类终态：属于配置/权限问题，修正后需重新发起（不自动退避重试） */
export const ATTEMPT_BLOCKED_STATUSES: ReplicationAttemptStatus[] = [
  'blocked_manual',
  'blocked_not_configured',
  'blocked_user_client',
  'blocked_no_user_account',
  'blocked_source_anchor',
  'blocked_target_chat',
];
/** 后台允许「重试」的终态（其余状态一律不提供重试入口） */
export const ATTEMPT_RETRYABLE_STATUSES: ReplicationAttemptStatus[] = ['retryable_failed', 'claim_timeout'];

/** 判定：该状态是否可重试（服务端与前端共用同一口径） */
export function isAttemptRetryable(status: ReplicationAttemptStatus): boolean {
  return ATTEMPT_RETRYABLE_STATUSES.includes(status);
}

/** 判定：字符串是否为合法的轮次状态（管理端查询参数校验用） */
export function isReplicationAttemptStatus(value: string): value is ReplicationAttemptStatus {
  return Object.prototype.hasOwnProperty.call(ATTEMPT_STATUS_LABELS, value);
}

/** 判定：字符串是否为合法的中继失败原因（管理端查询参数校验用） */
export function isUserRelayFailureReason(value: string): value is UserRelayFailureReason {
  return Object.prototype.hasOwnProperty.call(RELAY_FAILURE_LABELS, value);
}

/**
 * 中继失败原因 → 轮次终态（策略 B fail-closed 判定表）。
 *
 * 为什么集中在一处：这张表就是「什么算可重试、什么算配置问题」的产品契约，
 * 散落在调用方会让后台展示与告警口径不一致。
 */
export function attemptStatusForRelayFailure(reason: UserRelayFailureReason): ReplicationAttemptStatus {
  switch (reason) {
    case 'not_configured':
      return 'blocked_not_configured';
    case 'client_unavailable':
      return 'blocked_user_client';
    case 'no_account':
      return 'blocked_no_user_account';
    case 'source_missing':
      return 'blocked_source_anchor';
    case 'target_missing':
      return 'blocked_target_chat';
    case 'permission_denied':
    case 'auth_invalid':
      return 'blocked_manual';
    case 'rate_limited':
    case 'network':
    case 'unknown':
    default:
      return 'retryable_failed';
  }
}

/** 指数退避：返回下次可重试时间；达到上限返回 `exhausted=true`（调用方升级 `blocked_manual`） */
export function computeRetryBackoff(
  retryCount: number,
  nowMs: number = Date.now(),
): { nextRetryAt: Date | null; exhausted: boolean } {
  const attemptIndex = Math.max(0, Math.floor(retryCount) || 0);
  if (attemptIndex >= RETRY_MAX_ATTEMPTS) return { nextRetryAt: null, exhausted: true };
  const delay = Math.min(
    RETRY_BACKOFF_MAX_MS,
    RETRY_BACKOFF_BASE_MS * RETRY_BACKOFF_FACTOR ** attemptIndex,
  );
  return { nextRetryAt: new Date(nowMs + delay), exhausted: false };
}

/** 分位数（升序取第 ceil(p/100 × n) 个；无样本返回 null） */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export interface BeginRoundInput {
  ownerType: TelegramCopyOwnerType;
  ownerId: string;
  sourceAccountId?: string | null;
  targetChatId?: string | null;
  idempotencyKey?: string | null;
  desiredCount: number;
  baselineReadyCount: number;
  triggeredBy?: ReplicationAttemptTrigger;
  operatorUserId?: string | null;
  retriedFromId?: string | null;
  /** 手动重试：跳过退避窗口与合并窗口（管理员显式操作，但仍不绕过「进行中轮次」判定） */
  force?: boolean;
}

export interface BeginRoundResult {
  /** 可写的轮次行；`null` 表示本轮无需记录（退避未到期或观测降级） */
  attempt: TelegramReplicationAttempt | null;
  /** 是否复用了既有行（合并窗口或进行中的轮次） */
  merged: boolean;
  /** 是否因退避窗口未到期而跳过（不写行） */
  skipped: boolean;
  /**
   * 上一轮实际执行中继的用户账号。
   *
   * 为什么必须回传：中继的 `random_id` 由「幂等键 + 执行账号」派生，只有**落回同一账号**
   * 时服务端才能据 `random_id` 去重（重试不产生重复群消息）。调用方把它作为
   * `preferredAccountId` 传给中继，把「重试同账号」从注释假设变成代码约束。
   */
  previousRelayAccountId: string | null;
}

/** 单轮失败/阻塞的收口参数 */
export interface FinishBlockedInput {
  status: ReplicationAttemptStatus;
  failureReason?: UserRelayFailureReason | null;
  failureSummary?: string | null;
  missingCount?: number;
  claimedAccountIds?: string[];
}

export interface RelayMetricsView {
  windowMs: number;
  since: string;
  /** 窗口内轮次总数（含阻塞） */
  attempts: number;
  /** 中继实际完成（转发成功）的轮次：succeeded + partial_success + claim_timeout */
  relaySucceeded: number;
  /** 中继执行失败（可重试 + 人工处理），不含配置类阻塞 */
  relayFailed: number;
  /** 配置/权限类阻塞（未发生中继调用） */
  blocked: number;
  succeeded: number;
  partialSuccess: number;
  claimTimeouts: number;
  /** 中继执行成功率 = relaySucceeded / (relaySucceeded + relayFailed)；低样本为 null */
  relaySuccessRate: number | null;
  /** 认领成功率 = (succeeded + partial_success) / relaySucceeded；低样本为 null */
  claimRate: number | null;
  relayDurationP50Ms: number | null;
  relayDurationP95Ms: number | null;
  claimDurationP50Ms: number | null;
  claimDurationP95Ms: number | null;
  failureReasons: Array<{ reason: UserRelayFailureReason; count: number }>;
  /** 契约常量：策略 B 不发生文件字节二次传输 */
  bytesRelayed: 0;
  /** 样本是否足以给出比率结论（false 时前端必须展示「样本不足」） */
  sampleSufficient: boolean;
  /** 统计是否被行数上限截断（true 表示只覆盖最近 N 条） */
  truncated: boolean;
}

/** 单轮详情（后台展开视图：为什么失败 / 影响 / 建议 / 是否可重试） */
export interface ReplicationAttemptDetailView {
  id: string;
  ownerType: TelegramCopyOwnerType;
  ownerLabel: string;
  status: ReplicationAttemptStatus;
  statusLabel: string;
  failureReason: UserRelayFailureReason | null;
  failureSummary: string | null;
  retryCount: number;
  desiredCount: number;
  baselineReadyCount: number;
  readyCount: number;
  missingCount: number;
  claimedAccountIds: string[];
  relayAccountId: string | null;
  relayMessageId: string | null;
  targetChatPreview: string | null;
  triggeredBy: ReplicationAttemptTrigger;
  startedAt: string | null;
  relayCompletedAt: string | null;
  claimDeadlineAt: string | null;
  completedAt: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
  retryable: boolean;
  timeline: Array<{ at: string; label: string; detail?: string }>;
  why: string;
  impact: string;
  advice: string;
}

/** 状态中文名（后台展示与告警文案共用，避免各处自造词） */
export const ATTEMPT_STATUS_LABELS: Record<ReplicationAttemptStatus, string> = {
  planned: '已规划',
  blocked_not_configured: '阻塞：中继未启用',
  blocked_user_client: '阻塞：客户端不可用',
  blocked_no_user_account: '阻塞：无可用用户账号',
  blocked_source_anchor: '阻塞：源消息不可读',
  blocked_target_chat: '阻塞：目标群不可用',
  blocked_manual: '阻塞：需人工处理',
  relay_running: '中继执行中',
  waiting_claims: '等待 Bot 认领',
  succeeded: '已达标',
  partial_success: '部分成功',
  claim_timeout: '认领超时',
  retryable_failed: '可重试失败',
};

/** 失败原因中文名（后台 Top N 分布与详情共用） */
export const RELAY_FAILURE_LABELS: Record<UserRelayFailureReason, string> = {
  not_configured: '中继未启用',
  client_unavailable: 'MTProto 客户端不可用',
  no_account: '无可用用户账号',
  source_missing: '源消息不可读',
  target_missing: '目标群未配置',
  permission_denied: '目标群权限不足',
  auth_invalid: '用户账号认证失效',
  rate_limited: 'Telegram 限流',
  network: '网络异常',
  unknown: '未知错误',
};

/** 各状态的「为什么 / 影响 / 建议」（后台失败详情四段式文案的唯一来源） */
const STATUS_GUIDANCE: Record<ReplicationAttemptStatus, { why: string; impact: string; advice: string }> = {
  planned: {
    why: '本轮已算出目标与缺口，尚未完成前置能力校验。',
    impact: '尚未发生任何中继与字节传输。',
    advice: '若长期停留在该状态，说明本轮未正常收口，请检查进程日志。',
  },
  blocked_not_configured: {
    why: 'TELEGRAM_USER_RELAY_ENABLED 未开启，策略 B 不可用。',
    impact: '新副本不会扩散；已有副本的下载不受影响。',
    advice: '在部署环境配置 TELEGRAM_USER_RELAY_ENABLED=true 并重启（构造期读取，不支持热开启）。',
  },
  blocked_user_client: {
    why: 'MTProto 客户端不可用（依赖缺失或初始化失败）。',
    impact: '无法执行服务端转发，副本扩散停摆。',
    advice: '检查后端依赖与启动日志中的客户端初始化错误。',
  },
  blocked_no_user_account: {
    why: '没有「已授权且启用」的 Telegram 用户账号。',
    impact: '中继无法开始，副本缺口持续存在。',
    advice: '在账号管理中新增用户账号并完成交互式授权，然后启用该账号。',
  },
  blocked_source_anchor: {
    why: '源消息不在用户账号可读的群/频道，或缺少 (chatId, messageId) 锚点。',
    impact: '无法定位可转发的源消息，副本扩散停摆。',
    advice: '确认网站上传的源群对用户账号可读；Bot 私聊来源需先经源消息准备链路进入可读群。',
  },
  blocked_target_chat: {
    why: '没有启用中的镜像规则目标群（副本可见群）。',
    impact: '中继没有可写入的目标位置。',
    advice: '在镜像规则中配置并启用目标群，且确保群内每个 Bot 已加入并具备接收权限。',
  },
  blocked_manual: {
    why: '需要人工处理的配置/权限/来源问题（含权限不足、认证失效、连续重试耗尽）。',
    impact: '自动重试已停止，副本缺口不会自行收敛。',
    advice: '按失败原因逐项排查：目标群权限、用户账号 session、Bot 隐私模式与入群状态。',
  },
  relay_running: {
    why: '正在执行幂等的 MTProto 服务端转发。',
    impact: '尚未产生副本；不发生文件字节二次传输。',
    advice: '若长期停留，检查用户账号是否被限流或进程是否中断。',
  },
  waiting_claims: {
    why: '转发已成功，正在等待群内 Bot 通过入站轮询认领各自的 file_id。',
    impact: '认领窗口内未新增 ready 副本即记为认领超时。',
    advice: '若反复超时，检查群内 Bot 是否已加入、是否关闭隐私模式或设为管理员、入站轮询是否开启。',
  },
  succeeded: {
    why: '中继后新增副本已达到有效目标数。',
    impact: '该文件的副本分布已达标。',
    advice: '无需操作。',
  },
  partial_success: {
    why: '中继后至少有一个 Bot 认领了副本，但尚未达到有效目标数。',
    impact: '副本分布有改善但仍不均衡，负载可能继续集中在少数账号。',
    advice: '下一轮懒扩散会继续补齐；若长期停留在部分成功，检查其余 Bot 的入群与权限。',
  },
  claim_timeout: {
    why: '中继转发成功，但认领窗口内没有新增 ready 副本。',
    impact: '转发出去的消息无人认领，副本数没有增长。',
    advice: '依次检查：Bot 是否在群内、是否关闭隐私模式或设为管理员、入站轮询是否开启。',
  },
  retryable_failed: {
    why: '临时性失败（Telegram 限流、网络异常或未知错误）。',
    impact: '本轮未产生副本；已有副本的下载不受影响。',
    advice: '系统会按指数退避自动重试；无需人工干预，除非长期不收敛。',
  },
};

/**
 * 副本扩散轮次持久化服务（策略 B 的可观测性底座）。
 *
 * 职责边界：
 * - **只做持久化与派生视图**，不发起任何 Telegram 请求、不做扩散决策；
 * - 观测写入失败**绝不阻塞**下载/上传主链路：一律捕获 + 限频 WARN + 置降级标记；
 * - 进程内只保留降级标记，窗口指标一律来自持久化表（不冒充跨重启历史指标）。
 */
@Injectable()
export class ReplicationAttemptService {
  private readonly logger = new Logger(ReplicationAttemptService.name);
  /** 观测降级状态（进程内；写入/读取失败时置位，管理端据此提示「观测数据不完整」） */
  private degradedReason: string | null = null;
  private degradedAtMs = 0;
  private writeFailures = 0;
  private lastDegradedLogAtMs = 0;

  constructor(
    @InjectRepository(TelegramReplicationAttempt)
    private readonly repo: Repository<TelegramReplicationAttempt>,
  ) {}

  // ---------------- 降级标记 ----------------

  /** 观测是否降级（写入/读取失败）；`reason` 为脱敏摘要 */
  getObservability(): { degraded: boolean; reason: string | null; since: string | null; writeFailures: number } {
    return {
      degraded: this.degradedReason !== null,
      reason: this.degradedReason,
      since: this.degradedAtMs > 0 ? new Date(this.degradedAtMs).toISOString() : null,
      writeFailures: this.writeFailures,
    };
  }

  /** 清除降级标记（一次成功写入即视为恢复） */
  private clearDegraded(): void {
    this.degradedReason = null;
    this.degradedAtMs = 0;
  }

  /** 记录观测故障：计数 + 限频 WARN（异常不得把日志刷爆，也不得抛给主链路） */
  private markDegraded(action: string, error: unknown): void {
    this.writeFailures += 1;
    this.degradedReason = `${action}失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
    this.degradedAtMs = Date.now();
    const now = Date.now();
    if (now - this.lastDegradedLogAtMs < 60_000) return;
    this.lastDegradedLogAtMs = now;
    this.logger.warn(`副本扩散观测写入失败（主链路不受影响）：${this.degradedReason}`);
  }

  // ---------------- 轮次生命周期 ----------------

  /**
   * 开启一轮扩散记录。
   *
   * 判定顺序（保证同一 owner 只留一条「活跃链路」）：
   * 1. 存在进行中的轮次 → 复用（并发/手动重试都不制造重复轮次）；
   * 2. 最近一轮终态的 `nextRetryAt` 未到期 → **跳过且不写行**（退避保护 + 行数控制）；
   * 3. 最近一轮终态仍在合并窗口内 → 复用该行并累加 `retryCount`；
   * 4. 否则新建行；可重试失败链在继承窗口内继承 `retryCount`（保证退避上限可达）。
   */
  async beginRound(input: BeginRoundInput): Promise<BeginRoundResult> {
    const now = Date.now();
    try {
      const latest = await this.latestForOwner(input.ownerType, input.ownerId);
      const previousRelayAccountId = latest?.relayAccountId ?? null;
      if (latest && ATTEMPT_ACTIVE_STATUSES.includes(latest.status)) {
        return { attempt: latest, merged: true, skipped: false, previousRelayAccountId };
      }

      if (!input.force && latest?.nextRetryAt && latest.nextRetryAt.getTime() > now) {
        return { attempt: null, merged: false, skipped: true, previousRelayAccountId };
      }

      // 阻塞类终态的重开门禁（见 NON_REOPENABLE_BLOCKED_STATUS 的说明）：
      // `blocked_manual` 必须由管理员显式重试，懒触发一律跳过（不写行、不调 Telegram）。
      if (!input.force && latest?.status === NON_REOPENABLE_BLOCKED_STATUS) {
        return { attempt: null, merged: false, skipped: true, previousRelayAccountId };
      }

      const mergeable = !input.force
        && latest !== null
        && latest !== undefined
        && ATTEMPT_TERMINAL_STATUSES.includes(latest.status)
        && latest.createdAt.getTime() >= now - ATTEMPT_MERGE_WINDOW_MS;

      if (mergeable && latest) {
        const merged = await this.repo.update({ id: latest.id }, {
          ...this.roundPatch(input, now),
          retryCount: (latest.retryCount ?? 0) + 1,
          // 合并轮次沿用原触发来源的「人工」标记：管理员显式操作过的轮次不应在时间线里丢失
          triggeredBy: latest.triggeredBy === 'manual' && input.triggeredBy !== 'manual'
            ? 'manual'
            : (input.triggeredBy ?? 'lazy'),
          operatorUserId: input.operatorUserId ?? latest.operatorUserId ?? null,
          updatedAt: new Date(now),
        });
        void merged;
        const refreshed = await this.repo.findOne({ where: { id: latest.id } });
        this.clearDegraded();
        return { attempt: refreshed, merged: true, skipped: false, previousRelayAccountId };
      }

      const inherited = this.inheritRetryCount(latest, now);
      const created = this.repo.create({
        ...this.roundPatch(input, now),
        retryCount: inherited,
        triggeredBy: input.triggeredBy ?? 'lazy',
        operatorUserId: input.operatorUserId ?? null,
        retriedFromId: input.retriedFromId ?? null,
      });
      const saved = await this.repo.save(created);
      this.clearDegraded();
      return { attempt: saved, merged: false, skipped: false, previousRelayAccountId };
    } catch (error) {
      this.markDegraded('开启扩散轮次', error);
      return { attempt: null, merged: false, skipped: false, previousRelayAccountId: null };
    }
  }

  /** 新建/复用轮次时重置为「本轮开始」的字段（不改变 retryCount 与人工标记） */
  private roundPatch(input: BeginRoundInput, nowMs: number): Partial<TelegramReplicationAttempt> {
    return {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      sourceAccountId: input.sourceAccountId ?? null,
      targetChatId: input.targetChatId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      desiredCount: Math.max(0, Math.floor(input.desiredCount) || 0),
      baselineReadyCount: Math.max(0, Math.floor(input.baselineReadyCount) || 0),
      claimedAccountIds: null,
      missingCount: Math.max(0, Math.floor(input.desiredCount) || 0),
      status: 'planned',
      failureReason: null,
      failureSummary: null,
      relayAccountId: null,
      relayMessageId: null,
      startedAt: new Date(nowMs),
      relayCompletedAt: null,
      claimDeadlineAt: null,
      completedAt: null,
      nextRetryAt: null,
      updatedAt: new Date(nowMs),
    };
  }

  /**
   * 新建行时是否继承重试计数。
   *
   * 只对「可重试失败链」（`retryable_failed` / `claim_timeout`）在继承窗口内继承：
   * 配置类阻塞被修正后应当从零开始（否则一次误配置会把计数永久抬高）。
   */
  private inheritRetryCount(latest: TelegramReplicationAttempt | null, nowMs: number): number {
    if (!latest) return 0;
    if (!ATTEMPT_RETRYABLE_STATUSES.includes(latest.status)) return 0;
    if (latest.updatedAt.getTime() < nowMs - RETRY_COUNT_INHERIT_WINDOW_MS) return 0;
    return latest.retryCount ?? 0;
  }

  /** 标记进入中继执行（`relay_running`） */
  async markRelayStarted(attemptId: string): Promise<void> {
    await this.patch(attemptId, { status: 'relay_running', updatedAt: new Date() }, '标记中继开始');
  }

  /** 标记中继转发成功，进入认领等待窗口（`waiting_claims`） */
  async markRelaySucceeded(
    attemptId: string,
    params: { relayAccountId: string; relayMessageId?: string | null; claimDeadlineAt: Date },
  ): Promise<void> {
    const now = new Date();
    await this.patch(attemptId, {
      status: 'waiting_claims',
      relayAccountId: params.relayAccountId,
      relayMessageId: params.relayMessageId ?? null,
      relayCompletedAt: now,
      claimDeadlineAt: params.claimDeadlineAt,
      updatedAt: now,
    }, '标记中继成功');
  }

  /**
   * 收口一次失败/阻塞（前置能力校验失败与中继执行失败共用）。
   *
   * 可重试失败在此处应用指数退避；达到上限自动升级 `blocked_manual`
   * （避免「无限重试」把同一问题反复打向 Telegram）。
   */
  async finishBlocked(
    attemptId: string,
    input: FinishBlockedInput,
  ): Promise<TelegramReplicationAttempt | null> {
    const now = Date.now();
    let status = input.status;
    let nextRetryAt: Date | null = null;
    let summary = input.failureSummary ?? null;

    if (status === 'retryable_failed') {
      const latest = await this.safeFind(attemptId);
      const backoff = computeRetryBackoff(latest?.retryCount ?? 0, now);
      if (backoff.exhausted) {
        status = 'blocked_manual';
        summary = [summary, `已连续可重试失败 ${RETRY_MAX_ATTEMPTS} 次，自动重试已停止`]
          .filter(Boolean)
          .join('；');
      } else {
        nextRetryAt = backoff.nextRetryAt;
      }
    }

    return this.patch(attemptId, {
      status,
      failureReason: input.failureReason ?? null,
      failureSummary: summary ? summary.slice(0, FAILURE_SUMMARY_LIMIT) : null,
      missingCount: Math.max(0, Math.floor(input.missingCount ?? 0) || 0),
      claimedAccountIds: input.claimedAccountIds ?? null,
      completedAt: new Date(now),
      nextRetryAt,
      updatedAt: new Date(now),
    }, '收口扩散失败');
  }

  /**
   * 认领窗口结束后的结算：判定 `succeeded` / `partial_success` / `claim_timeout`。
   *
   * 口径（产品已确认）：新增 ≥1 个 ready 副本 = `partial_success`；
   * 达到 `desiredCount` = `succeeded`；窗口内零新增 = `claim_timeout`（可退避重试）。
   */
  async settleClaims(
    attemptId: string,
    params: { desiredCount: number; baselineReadyCount: number; readyAccountIds: string[] },
  ): Promise<TelegramReplicationAttempt | null> {
    const attempt = await this.safeFind(attemptId);
    if (!attempt) return null;

    const ready = Array.from(new Set(params.readyAccountIds.filter(Boolean)));
    const baseline = attempt.baselineReadyCount ?? params.baselineReadyCount;
    const desired = Math.max(1, attempt.desiredCount || params.desiredCount || 1);
    const gained = Math.max(0, ready.length - baseline);
    const missingCount = Math.max(0, desired - ready.length);
    const now = Date.now();

    let status: ReplicationAttemptStatus;
    let failureSummary: string | null = null;
    let nextRetryAt: Date | null = null;

    if (gained === 0) {
      status = 'claim_timeout';
      const backoff = computeRetryBackoff(attempt.retryCount ?? 0, now);
      failureSummary = `中继转发成功但认领窗口内没有新增 ready 副本（基线 ${baseline} → 当前 ${ready.length}）`;
      if (backoff.exhausted) {
        status = 'blocked_manual';
        failureSummary += `；已连续 ${RETRY_MAX_ATTEMPTS} 次未认领，自动重试已停止`;
      } else {
        nextRetryAt = backoff.nextRetryAt;
      }
    } else if (ready.length >= desired) {
      status = 'succeeded';
    } else {
      status = 'partial_success';
    }

    return this.patch(attemptId, {
      status,
      failureReason: status === 'claim_timeout' || status === 'blocked_manual' ? 'unknown' : null,
      failureSummary,
      claimedAccountIds: ready,
      missingCount,
      completedAt: new Date(now),
      nextRetryAt,
      updatedAt: new Date(now),
    }, '结算认领结果');
  }

  /**
   * 记录一次 Bot 认领（入站链路调用）。
   *
   * 语义：把账号追加到该 owner **进行中**轮次的 `claimedAccountIds`（去重）。
   * 找不到进行中轮次时静默返回（普通备份群消息本就没有对应轮次，属正常现象）。
   */
  async recordClaim(ownerType: TelegramCopyOwnerType, ownerId: string, accountId: string): Promise<void> {
    const account = (accountId || '').trim();
    if (!account) return;
    try {
      const active = await this.repo.findOne({
        where: { ownerType, ownerId, status: In(ATTEMPT_ACTIVE_STATUSES) },
        order: { createdAt: 'DESC' },
      });
      if (!active) return;
      const claimed = new Set(active.claimedAccountIds ?? []);
      if (claimed.has(account)) return;
      claimed.add(account);
      await this.repo.update({ id: active.id }, {
        claimedAccountIds: Array.from(claimed),
        updatedAt: new Date(),
      });
      this.clearDegraded();
    } catch (error) {
      this.markDegraded('记录认领事件', error);
    }
  }

  // ---------------- 查询 ----------------

  /** 某 owner 最近一轮（任意状态；时间线判定的唯一入口） */
  async latestForOwner(
    ownerType: TelegramCopyOwnerType,
    ownerId: string,
  ): Promise<TelegramReplicationAttempt | null> {
    return this.repo.findOne({
      where: { ownerType, ownerId },
      order: { createdAt: 'DESC' },
    });
  }

  /** 最近轮次列表（后台时间线；按状态/原因/owner/时间筛选，有界返回） */
  async listRecent(params: {
    status?: ReplicationAttemptStatus | ReplicationAttemptStatus[];
    failureReason?: UserRelayFailureReason;
    ownerType?: TelegramCopyOwnerType;
    ownerId?: string;
    sinceMs?: number;
    limit?: number;
  } = {}): Promise<{ items: TelegramReplicationAttempt[]; truncated: boolean }> {
    const limit = Math.min(500, Math.max(1, Math.floor(params.limit ?? 50)));
    try {
      const qb = this.repo.createQueryBuilder('attempt').orderBy('attempt.createdAt', 'DESC').limit(limit + 1);
      if (params.status) {
        const statuses = Array.isArray(params.status) ? params.status : [params.status];
        if (statuses.length > 0) qb.andWhere('attempt.status IN (:...statuses)', { statuses });
      }
      if (params.failureReason) {
        qb.andWhere('attempt.failureReason = :failureReason', { failureReason: params.failureReason });
      }
      if (params.ownerType) qb.andWhere('attempt.ownerType = :ownerType', { ownerType: params.ownerType });
      if (params.ownerId) qb.andWhere('attempt.ownerId = :ownerId', { ownerId: params.ownerId });
      if (params.sinceMs && params.sinceMs > 0) {
        qb.andWhere('attempt.createdAt >= :since', { since: new Date(Date.now() - params.sinceMs) });
      }
      const rows = await qb.getMany();
      this.clearDegraded();
      return { items: rows.slice(0, limit), truncated: rows.length > limit };
    } catch (error) {
      this.markDegraded('查询扩散轮次', error);
      return { items: [], truncated: false };
    }
  }

  /** 单轮详情（含时间线、可重试性与处理建议）；不存在返回 null */
  async getDetail(id: string): Promise<ReplicationAttemptDetailView | null> {
    const attempt = await this.safeFind(id);
    if (!attempt) return null;
    return this.toDetailView(attempt);
  }

  /** 单轮原始记录（手动重试前的服务端校验用） */
  async findById(id: string): Promise<TelegramReplicationAttempt | null> {
    return this.safeFind(id);
  }

  /**
   * 窗口指标（后台指标卡 + 告警阈值判定共用）。
   *
   * 有界：按窗口拉取最多 `METRICS_MAX_ROWS` 行（只取必要列），
   * 百分位在 JS 内计算（跨方言没有统一的分位数 SQL）；截断时返回 `truncated`。
   */
  async computeMetrics(windowMs: number = METRICS_DEFAULT_WINDOW_MS): Promise<RelayMetricsView> {
    const since = new Date(Date.now() - Math.max(60_000, windowMs));
    const empty: RelayMetricsView = {
      windowMs,
      since: since.toISOString(),
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

    let rows: TelegramReplicationAttempt[];
    try {
      rows = await this.repo.find({
        where: { createdAt: MoreThan(since) },
        select: [
          'id', 'status', 'failureReason', 'startedAt', 'relayCompletedAt',
          'completedAt', 'createdAt',
        ],
        order: { createdAt: 'DESC' },
        take: METRICS_MAX_ROWS + 1,
      });
      this.clearDegraded();
    } catch (error) {
      this.markDegraded('统计扩散指标', error);
      return empty;
    }

    const truncated = rows.length > METRICS_MAX_ROWS;
    const window = rows.slice(0, METRICS_MAX_ROWS);
    const relayDurations: number[] = [];
    const claimDurations: number[] = [];
    const reasonCounts = new Map<UserRelayFailureReason, number>();

    for (const row of window) {
      if (row.status === 'succeeded') empty.succeeded += 1;
      else if (row.status === 'partial_success') empty.partialSuccess += 1;
      else if (row.status === 'claim_timeout') empty.claimTimeouts += 1;
      else if (row.status === 'retryable_failed' || row.status === 'blocked_manual') empty.relayFailed += 1;
      else if (ATTEMPT_BLOCKED_STATUSES.includes(row.status)) empty.blocked += 1;

      if (row.relayCompletedAt) {
        empty.relaySucceeded += 1;
        if (row.startedAt) {
          const duration = row.relayCompletedAt.getTime() - row.startedAt.getTime();
          if (Number.isFinite(duration) && duration >= 0) relayDurations.push(duration);
        }
        if (row.completedAt && row.status !== 'claim_timeout' && row.status !== 'blocked_manual') {
          const duration = row.completedAt.getTime() - row.relayCompletedAt.getTime();
          if (Number.isFinite(duration) && duration >= 0) claimDurations.push(duration);
        }
      }

      if (row.failureReason) {
        reasonCounts.set(row.failureReason, (reasonCounts.get(row.failureReason) ?? 0) + 1);
      }
    }

    const relayDenominator = empty.relaySucceeded + empty.relayFailed;
    const claimed = empty.succeeded + empty.partialSuccess;
    const sampleSufficient = relayDenominator >= METRICS_MIN_SAMPLES;

    return {
      ...empty,
      attempts: window.length,
      relaySuccessRate: sampleSufficient ? Number((empty.relaySucceeded / relayDenominator).toFixed(4)) : null,
      claimRate: sampleSufficient && empty.relaySucceeded > 0
        ? Number((claimed / empty.relaySucceeded).toFixed(4))
        : null,
      relayDurationP50Ms: percentile(relayDurations, 50),
      relayDurationP95Ms: percentile(relayDurations, 95),
      claimDurationP50Ms: percentile(claimDurations, 50),
      claimDurationP95Ms: percentile(claimDurations, 95),
      failureReasons: Array.from(reasonCounts.entries())
        .map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count),
      sampleSufficient,
      truncated,
    };
  }

  /**
   * 生命周期清理。
   *
   * 两步：
   * 1. **先收敛悬挂行**：进程中断会让轮次永远停在 `planned/relay_running/waiting_claims`；
   *    超过 `activeBefore` 未更新的一律收敛为终态（已转发过的记 `claim_timeout`，
   *    未转发的记 `retryable_failed`），否则「进行中」会被永久误读为「正在跑」；
   * 2. **再按保留窗口删除终态行**：只删 `nextRetryAt` 已过期或为空的行，
   *    避免删掉仍在重试窗口内的记录。
   *
   * 与副本记录清理（`FileCopyService.purgeStale`）**分开评审**：副本是业务数据，
   * 轮次是可审计证据，保留期与判定条件不同。
   */
  async purgeStale(params: { activeBefore: Date; terminalBefore: Date }): Promise<{ converged: number; deleted: number }> {
    let converged = 0;
    let deleted = 0;
    try {
      const hanging = await this.repo.find({
        where: { status: In(ATTEMPT_ACTIVE_STATUSES), updatedAt: LessThan(params.activeBefore) },
        take: 500,
      });
      for (const row of hanging) {
        const settled: Partial<TelegramReplicationAttempt> = row.relayCompletedAt
          ? {
            status: 'claim_timeout',
            failureReason: 'unknown',
            failureSummary: '轮次在认领窗口内未收口（进程中断或长时间无更新），已按认领超时收敛',
            nextRetryAt: null,
          }
          : {
            status: 'retryable_failed',
            failureReason: 'unknown',
            failureSummary: '轮次未完成中继即中断（进程中断或长时间无更新），已收敛为可重试失败',
            nextRetryAt: null,
          };
        await this.repo.update({ id: row.id }, {
          ...settled,
          missingCount: Math.max(0, (row.desiredCount ?? 0) - (row.baselineReadyCount ?? 0)),
          completedAt: row.updatedAt ?? new Date(),
          updatedAt: new Date(),
        });
        converged += 1;
      }

      const removable = await this.repo.find({
        where: { status: In(ATTEMPT_TERMINAL_STATUSES), updatedAt: LessThan(params.terminalBefore) },
        select: ['id', 'nextRetryAt'],
        take: 5000,
      });
      const now = Date.now();
      const ids = removable
        .filter((row) => !row.nextRetryAt || row.nextRetryAt.getTime() <= now)
        .map((row) => row.id);
      if (ids.length > 0) {
        const result = await this.repo.delete({ id: In(ids) });
        deleted = result.affected ?? ids.length;
      }
      if (converged > 0 || deleted > 0) {
        this.logger.log(`扩散轮次清理完成：收敛悬挂 ${converged} 条，删除过期 ${deleted} 条`);
      }
      this.clearDegraded();
    } catch (error) {
      this.markDegraded('清理扩散轮次', error);
    }
    return { converged, deleted };
  }

  // ---------------- 视图派生 ----------------

  /**
   * 详情视图（脱敏 + 时间线 + 处理建议）。
   *
   * 脱敏口径：chat id 只留末 4 位；执行账号与消息 id 只留前 4 位——
   * 它们仅用于**审计引用**（定位是轮次 id 的职责），完整值不出管理接口。
   */
  toDetailView(attempt: TelegramReplicationAttempt): ReplicationAttemptDetailView {
    const guidance = STATUS_GUIDANCE[attempt.status];
    return {
      id: attempt.id,
      ownerType: attempt.ownerType,
      ownerLabel: this.ownerLabel(attempt.ownerType, attempt.ownerId),
      status: attempt.status,
      statusLabel: ATTEMPT_STATUS_LABELS[attempt.status],
      failureReason: attempt.failureReason,
      failureSummary: attempt.failureSummary,
      retryCount: attempt.retryCount ?? 0,
      desiredCount: attempt.desiredCount ?? 0,
      baselineReadyCount: attempt.baselineReadyCount ?? 0,
      readyCount: (attempt.claimedAccountIds ?? []).length || attempt.baselineReadyCount || 0,
      missingCount: attempt.missingCount ?? 0,
      claimedAccountIds: attempt.claimedAccountIds ?? [],
      relayAccountId: this.maskInternalId(attempt.relayAccountId),
      relayMessageId: this.maskInternalId(attempt.relayMessageId),
      targetChatPreview: this.maskChatId(attempt.targetChatId),
      triggeredBy: attempt.triggeredBy,
      startedAt: this.iso(attempt.startedAt),
      relayCompletedAt: this.iso(attempt.relayCompletedAt),
      claimDeadlineAt: this.iso(attempt.claimDeadlineAt),
      completedAt: this.iso(attempt.completedAt),
      nextRetryAt: this.iso(attempt.nextRetryAt),
      createdAt: this.iso(attempt.createdAt) ?? new Date(0).toISOString(),
      updatedAt: this.iso(attempt.updatedAt) ?? new Date(0).toISOString(),
      retryable: isAttemptRetryable(attempt.status),
      timeline: this.buildTimeline(attempt),
      why: guidance.why,
      impact: guidance.impact,
      advice: guidance.advice,
    };
  }

  private buildTimeline(attempt: TelegramReplicationAttempt): Array<{ at: string; label: string; detail?: string }> {
    const events: Array<{ at: string; label: string; detail?: string }> = [];
    const push = (value: Date | null | undefined, label: string, detail?: string): void => {
      const iso = this.iso(value);
      if (iso) events.push({ at: iso, label, detail });
    };
    push(attempt.createdAt, '轮次开始', `目标 ${attempt.desiredCount ?? 0} 路，基线 ready ${attempt.baselineReadyCount ?? 0}`);
    push(attempt.startedAt, '开始执行');
    if (attempt.relayAccountId) {
      push(attempt.relayCompletedAt, '中继转发成功', `执行账号 ${this.maskInternalId(attempt.relayAccountId) ?? '***'}`);
    }
    push(attempt.claimDeadlineAt, '认领窗口截止');
    if ((attempt.claimedAccountIds ?? []).length > 0) {
      push(attempt.completedAt, 'Bot 认领结果', `${(attempt.claimedAccountIds ?? []).length} 个账号持有 ready 副本`);
    }
    push(attempt.completedAt, `收口：${ATTEMPT_STATUS_LABELS[attempt.status]}`, attempt.failureSummary ?? undefined);
    push(attempt.nextRetryAt, '计划重试时间');
    return events.sort((left, right) => left.at.localeCompare(right.at));
  }

  /** owner 展示标签：`file` 用短 ID；`fileUnique` 脱敏（不输出完整 file_unique_id） */
  private ownerLabel(ownerType: TelegramCopyOwnerType, ownerId: string): string {
    const value = (ownerId || '').trim();
    if (ownerType === 'fileUnique') return value.length <= 8 ? value : `${value.slice(0, 8)}…`;
    return value.length <= 16 ? value : `${value.slice(0, 16)}…`;
  }

  /** 内部标识脱敏：只保留前 4 位（账号 / 消息 id 仅作审计引用，不用于定位） */
  private maskInternalId(value: string | null | undefined): string | null {
    const trimmed = (value || '').trim();
    if (!trimmed) return null;
    return trimmed.length <= 4 ? '***' : `${trimmed.slice(0, 4)}…`;
  }

  /** chat id 脱敏（只保留末 4 位，避免把完整群标识写进接口响应） */
  private maskChatId(chatId: string | null | undefined): string | null {
    const trimmed = (chatId || '').trim();
    if (!trimmed) return null;
    if (trimmed.length <= 4) return '***';
    return `***${trimmed.slice(-4)}`;
  }

  private iso(value: Date | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  // ---------------- 内部写入 ----------------

  /** 定向更新（只写补丁列，避免与并发的认领回写互相覆盖整行） */
  private async patch(
    attemptId: string,
    patch: Partial<TelegramReplicationAttempt>,
    action: string,
  ): Promise<TelegramReplicationAttempt | null> {
    try {
      await this.repo.update({ id: attemptId }, patch);
      this.clearDegraded();
      return await this.repo.findOne({ where: { id: attemptId } });
    } catch (error) {
      this.markDegraded(action, error);
      return null;
    }
  }

  private async safeFind(id: string): Promise<TelegramReplicationAttempt | null> {
    try {
      const row = await this.repo.findOne({ where: { id } });
      this.clearDegraded();
      return row;
    } catch (error) {
      this.markDegraded('读取扩散轮次', error);
      return null;
    }
  }
}
