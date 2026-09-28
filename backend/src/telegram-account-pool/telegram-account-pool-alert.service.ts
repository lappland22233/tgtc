import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AlertLevel } from '../common/entities/alert.entity';
import { AlertEngineService } from '../alert/alert-engine.service';
import { AlertRuleEvaluation } from '../alert/alert.rules';
import { FileCopyService } from './file-copy.service';
import { RelayCapabilityService, RelayCapabilitySnapshot } from './relay-capability.service';
import { ReplicationAttemptService } from './replication-attempt.service';
import { ReplicaTargetResolver } from './replica-target.resolver';
import { AccountPoolCounters, AccountPoolSnapshot } from './telegram-account-pool.types';
import { TelegramAccountPoolService } from './telegram-account-pool.service';

/**
 * 回退率告警阈值（**预发布基线测试后冻结**；当前为保守默认值，避免噪声）。
 * 采样不足（< MIN_SAMPLES 次选号）时不判回退率，防止低流量下误报。
 */
const FALLBACK_RATE_WARNING = 0.2;
const FALLBACK_RATE_MIN_SAMPLES = 5;
/** 单次采集窗口内「中继失败 / 中继认领超时 / 回复失败」的告警触发次数 */
const REPLY_FAILURE_BURST = 1;
const RELAY_FAILURE_BURST = 3;
const RELAY_CLAIM_TIMEOUT_BURST = 1;
/**
 * ≥4GiB 分层未达标文件数的告警阈值。
 *
 * 为什么阈值取 1：该分层的文件数量级本来就小（生产里通常个位数），
 * 任何一路缺口都意味着「某个大分卷只能压在一个账号上」——这正是 DC-5 限流
 * 与下载失败的根因，不能等到比例阈值。
 */
const LARGE_FILE_UNSATISFIED_WARNING = 1;
/**
 * 大文件覆盖率的采集间隔（毫秒）。
 *
 * 为什么低频：覆盖率是分组查询（跨 owner 聚合 + 文件大小分层），
 * 每分钟跑一遍会给数据库增加与告警价值不成比例的负载；10 分钟粒度足以
 * 支撑「退化」类告警。
 */
const COVERAGE_COLLECT_INTERVAL_MS = 10 * 60 * 1000;
/** 大文件主视图分层标签（与审计报告 `LARGE_FILE_TIER_LABEL` 保持一致） */
const LARGE_FILE_TIER_LABEL = '≥4GiB';

/**
 * 状态评估所需的**异步事实**（由 `runOnce()` 采集，`evaluate()` 只消费）。
 *
 * 为什么不让 `evaluate()` 自己去查：它是纯函数，单测直接构造入参即可覆盖
 * 「中继未就绪 / 观测降级 / 大文件退化」三条规则，不必搭建整条依赖链。
 */
export interface RelayAlertContext {
  /** 中继「已启用但不可用」的原因；null = 就绪或未启用中继（未启用是显式选择，不告警） */
  relayNotReadyReason: string | null;
  /** 观测是否降级（轮次写入/读取失败 → 指标与事件不完整） */
  observabilityDegraded: boolean;
  observabilityReason: string | null;
  observabilityWriteFailures: number;
  /** 大文件覆盖率事实（低频采集；null = 本轮未采集） */
  largeFileCoverage: {
    label: string;
    files: number;
    unsatisfied: number;
    readyAccounts: number;
    schedulableAccounts: number;
  } | null;
}

/** 默认上下文：未采集时三条规则一律不触发（绝不把「没采到」当成「健康」或「异常」） */
function emptyRelayContext(): RelayAlertContext {
  return {
    relayNotReadyReason: null,
    observabilityDegraded: false,
    observabilityReason: null,
    observabilityWriteFailures: 0,
    largeFileCoverage: null,
  };
}

const COUNTER_KEYS: Array<keyof AccountPoolCounters> = [
  'selections',
  'failovers',
  'fallbacks',
  'unresolved',
  'streamFailures',
  'replyFailures',
  'inboundRegistrationFailures',
  'relayAttempts',
  'relaySucceeded',
  'relayFailed',
  'relayClaimsMissed',
  'inboundBridgeMisses',
  'anchorConflicts',
  'fallbackThrottled',
  'largeFileSlotThrottled',
  'mainChatPlantAttempts',
  'mainChatPlantFailures',
  'mainChatPlantTakeovers',
];

function zeroCounters(): AccountPoolCounters {
  return {
    selections: 0,
    failovers: 0,
    fallbacks: 0,
    unresolved: 0,
    streamFailures: 0,
    replyFailures: 0,
    inboundRegistrationFailures: 0,
    relayAttempts: 0,
    relaySucceeded: 0,
    relayFailed: 0,
    relayClaimsMissed: 0,
    inboundBridgeMisses: 0,
    anchorConflicts: 0,
    fallbackThrottled: 0,
    largeFileSlotThrottled: 0,
    mainChatPlantAttempts: 0,
    mainChatPlantFailures: 0,
    mainChatPlantTakeovers: 0,
  };
}

/** 两次快照的增量（只看增长，避免累计值触发长期告警） */
function diffCounters(current: AccountPoolCounters, previous: AccountPoolCounters): AccountPoolCounters {
  const delta = zeroCounters();
  for (const key of COUNTER_KEYS) {
    delta[key] = Math.max(0, current[key] - previous[key]);
  }
  return delta;
}

/**
 * Bot 账号池告警：把「运行态」而非「流量指标」转成告警。
 *
 * 为什么单独一层：账号池的健康度体现在
 * 账号冷却、回退率、副本扩散失败、入站回复失败——这些都不在 access_logs 预聚合指标里，
 * 因此不能复用 `evaluateAndCreateAlerts(metrics)` 规则评估，只能按状态采集后调用
 * `AlertEngineService.createAlerts()`（与 SEC_* 规则同一模式）。
 *
 * 计数为进程内累计值，故按「增量」判定；每轮采集后重置基线。
 *
 * 覆盖的规则（前五条为账号池/扩散专有，后三条为策略 B 观测面）：
 * `BOT_POOL_ALL_UNAVAILABLE`、`BOT_POOL_FALLBACK_RATE`、`RELAY_FAILURE_BURST`、
 * `RELAY_CLAIM_TIMEOUT_BURST`、`BOT_REPLY_FAILING`、`RELAY_NOT_READY`、
 * `LARGE_FILE_COVERAGE_DEGRADED`、`REPLICATION_OBSERVABILITY_GAP`。
 */
@Injectable()
export class TelegramAccountPoolAlertService {
  private readonly logger = new Logger(TelegramAccountPoolAlertService.name);
  private lastCounters: AccountPoolCounters = zeroCounters();
  /** 上次大文件覆盖率采集时间（0 = 从未采集，首个 tick 立即采集） */
  private lastCoverageAtMs = 0;

  constructor(
    private readonly pool: TelegramAccountPoolService,
    // 必须显式 `@Inject(X)`：`X | null` 联合类型发出的是 `Object`，
    // 否则 `@Optional()` 会把解析失败静默降级成 `null`（告警只写日志、永不落库）。
    @Optional() @Inject(AlertEngineService)
    private readonly alertEngine: AlertEngineService | null = null,
    // 中继能力快照：判定「中继已启用但不可用」
    @Optional() @Inject(RelayCapabilityService)
    private readonly capability: RelayCapabilityService | null = null,
    // 扩散轮次：读取观测降级标记（同步，代价可忽略）
    @Optional() @Inject(ReplicationAttemptService)
    private readonly attempts: ReplicationAttemptService | null = null,
    // 大文件覆盖率：低频采集（分组查询代价高）
    @Optional() @Inject(FileCopyService)
    private readonly copies: FileCopyService | null = null,
    @Optional() @Inject(ReplicaTargetResolver)
    private readonly replicaTargets: ReplicaTargetResolver | null = null,
  ) {}

  /**
   * 状态评估（纯函数，便于单测）：返回本轮应触发但尚未创建的告警。
   * 账号池未生效时一律不告警（「未启用」不是异常）。
   */
  evaluate(
    snapshot: AccountPoolSnapshot,
    delta: AccountPoolCounters,
    context: RelayAlertContext = emptyRelayContext(),
  ): AlertRuleEvaluation[] {
    if (!snapshot.enabled) return [];
    const evaluations: AlertRuleEvaluation[] = [];
    const accounts = snapshot.accounts;

    // 可调度口径必须与 TelegramAccountPoolService.isSchedulable 完全一致（含在飞上限），
    // 否则「全部账号满载」这一真实不可用状态会被漏报。
    const schedulable = accounts.filter(
      (account) => account.enabled && !account.coolingDown && account.inflight < account.maxInflight,
    );
    if (accounts.length > 0 && schedulable.length === 0) {
      const detail = accounts
        .map((account) => `${account.id}(冷却${Math.ceil(account.cooldownRemainingMs / 1000)}s，在飞${account.inflight}/${account.maxInflight})`)
        .join('、');
      evaluations.push({
        ruleId: 'BOT_POOL_ALL_UNAVAILABLE',
        level: AlertLevel.CRITICAL,
        title: 'Bot 账号池全部不可用',
        message: `池内 ${accounts.length} 个账号当前均不可调度（冷却 / 已禁用 / 在飞满载），下载只能回退到源账号或返回可诊断失败：${detail}`,
        context: {
          accounts: accounts.length,
          coolingDown: accounts.filter((account) => account.coolingDown).length,
          disabled: accounts.filter((account) => !account.enabled).length,
          saturated: accounts.filter((account) => account.enabled && account.inflight >= account.maxInflight).length,
        },
      });
    }

    if (delta.selections >= FALLBACK_RATE_MIN_SAMPLES) {
      const rate = delta.fallbacks / delta.selections;
      if (rate > FALLBACK_RATE_WARNING) {
        evaluations.push({
          ruleId: 'BOT_POOL_FALLBACK_RATE',
          level: AlertLevel.WARNING,
          title: 'Bot 账号池回退率偏高',
          message: `最近 ${delta.selections} 次选号中回退 ${delta.fallbacks} 次（${(rate * 100).toFixed(1)}%），`
            + `另有 ${delta.unresolved} 次因归属不明按安全策略拒绝回退。`,
          context: {
            selections: delta.selections,
            fallbacks: delta.fallbacks,
            unresolved: delta.unresolved,
            fallbackRate: Number(rate.toFixed(4)),
          },
        });
      }
    }

    if (delta.relayFailed >= RELAY_FAILURE_BURST) {
      evaluations.push({
        ruleId: 'RELAY_FAILURE_BURST',
        level: AlertLevel.WARNING,
        title: '用户账号中继持续失败',
        message: `最近失败 ${delta.relayFailed} 次用户账号中继（成功 ${delta.relaySucceeded} 次）；`
          + '副本扩散只保留「用户账号服务端中继」一条链路，不存在任何字节二次传输的降级路径，'
          + '因此副本缺口会持续存在直到中继恢复。'
          + '请检查：user 账号是否已授权并启用、是否同时是源群与副本可见群成员、'
          + '以及副本可见群内每个 Bot 是否已关闭隐私模式或设为管理员。',
        context: { failed: delta.relayFailed, ok: delta.relaySucceeded, attempts: delta.relayAttempts },
      });
    }

    if (delta.relayClaimsMissed >= RELAY_CLAIM_TIMEOUT_BURST) {
      evaluations.push({
        ruleId: 'RELAY_CLAIM_TIMEOUT_BURST',
        level: AlertLevel.WARNING,
        title: '中继成功但无人认领副本',
        message: `最近有 ${delta.relayClaimsMissed} 次中继转发成功但认领窗口内没有新增 ready 副本；`
          + '转发成功只证明消息进了群，**不等于**任何 Bot 拿到了 file_id。'
          + '排查顺序：副本可见群内 Bot 是否已加入 → 是否关闭隐私模式或设为管理员 → 入站轮询是否开启。',
        context: { claimTimeouts: delta.relayClaimsMissed, succeeded: delta.relaySucceeded },
      });
    }

    if (delta.replyFailures >= REPLY_FAILURE_BURST) {
      evaluations.push({
        ruleId: 'BOT_REPLY_FAILING',
        level: AlertLevel.WARNING,
        title: 'Bot 入站回复失败',
        message: `最近有 ${delta.replyFailures} 次入站回复失败（按账号发送失败，不会改用默认账号代发）。`,
        context: { replyFailures: delta.replyFailures },
      });
    }

    // 中继「已启用但不可用」：配置层面看着在工作，实际一个副本也补不出来。
    // 只在中继开关已开启时告警——关闭是运维的显式选择，策略卡已展示，不需要告警打扰。
    if (context.relayNotReadyReason) {
      evaluations.push({
        ruleId: 'RELAY_NOT_READY',
        level: AlertLevel.CRITICAL,
        title: '用户账号中继未就绪',
        message: `TELEGRAM_USER_RELAY_ENABLED=true，但中继当前不可用：${context.relayNotReadyReason}。`
          + '副本扩散只保留「用户账号服务端中继」这一条链路，未就绪期间不会产生新副本，'
          + '缺口会持续存在直到修复（不会发生任何字节二次传输）。'
          + '可用 POST /api/admin/telegram-accounts/relay-preflight 做只读探测定位缺项。',
        context: { reason: context.relayNotReadyReason },
      });
    }

    // 大文件覆盖率退化：只判主分层（≥4GiB），且必须真的扫到文件才判（空集不是退化）
    if (
      context.largeFileCoverage
      && context.largeFileCoverage.files > 0
      && context.largeFileCoverage.unsatisfied >= LARGE_FILE_UNSATISFIED_WARNING
    ) {
      const coverage = context.largeFileCoverage;
      evaluations.push({
        ruleId: 'LARGE_FILE_COVERAGE_DEGRADED',
        level: AlertLevel.WARNING,
        title: '大文件副本覆盖率退化',
        message: `${coverage.label} 分层有 ${coverage.unsatisfied}/${coverage.files} 个文件未达到目标副本数；`
          + `已登记 ready 副本的账号 ${coverage.readyAccounts} 个、当前可调度账号 ${coverage.schedulableAccounts} 个。`
          + '大分卷是唯一能把单个账号打到限流的体量：请先确认中继是否正常，'
          + '再补齐可承载账号（不提供历史自动补偿，仅支持单轮手动重试）。',
        context: { ...coverage },
      });
    }

    if (context.observabilityDegraded) {
      evaluations.push({
        ruleId: 'REPLICATION_OBSERVABILITY_GAP',
        level: AlertLevel.WARNING,
        title: '副本扩散观测数据缺失',
        message: `扩散轮次的写入/读取出现失败（${context.observabilityWriteFailures} 次）：`
          + `${context.observabilityReason ?? '未提供原因'}。`
          + '此时后台指标与事件不完整，**不得**把「看不到失败」当成「没有失败」；'
          + '请先修复数据库写入（磁盘 / 锁等待 / 权限），再回看扩散是否真的健康。',
        context: {
          writeFailures: context.observabilityWriteFailures,
          reason: context.observabilityReason,
        },
      });
    }

    return evaluations;
  }

  /**
   * 采集评估所需的异步事实。
   *
   * 任何一项采集失败都只记录 debug 并保持「不触发」的默认值：
   * 告警采集既不能影响扩散主链路，也不能因为「读不到事实」就误报。
   */
  private async collectContext(): Promise<RelayAlertContext> {
    const context = emptyRelayContext();

    // 观测降级标记：同步读取，代价可忽略（必须最先取，避免被后面的重活拖延）
    const observability = this.attempts?.getObservability();
    if (observability?.degraded) {
      context.observabilityDegraded = true;
      context.observabilityReason = observability.reason;
      context.observabilityWriteFailures = observability.writeFailures;
    }

    if (this.capability) {
      try {
        await this.capability.refreshFacts();
        context.relayNotReadyReason = this.describeRelayNotReady(this.capability.snapshot());
      } catch (error) {
        this.logger.debug(`中继能力快照采集失败（本轮跳过就绪度告警）：${this.describe(error)}`);
      }
    }

    if (this.copies && this.replicaTargets && this.shouldCollectCoverage()) {
      this.lastCoverageAtMs = Date.now();
      try {
        const resolution = await this.replicaTargets.resolve();
        const coverage = await this.copies.replicationCoverageBySize({
          ownerType: 'fileUnique',
          target: Math.max(1, resolution.effectiveTarget),
        });
        const tier = coverage.tiers.find((item) => item.label === LARGE_FILE_TIER_LABEL);
        if (tier) {
          const readyByAccount = await this.copies.countReadyByAccount('fileUnique');
          context.largeFileCoverage = {
            label: tier.label,
            files: tier.files,
            unsatisfied: tier.unsatisfied,
            readyAccounts: [...readyByAccount.values()].filter((count) => count > 0).length,
            // 复用权威资格判定（与下载分流、审计报告同一口径）：
            // 自己拼条件会让告警里的「可调度账号」与界面上的「可调度」互相矛盾
            schedulableAccounts: this.replicaTargets
              .evaluateEligibility()
              .filter((item) => item.eligible).length,
          };
        }
      } catch (error) {
        this.logger.debug(`大文件覆盖率采集失败（本轮跳过覆盖率告警）：${this.describe(error)}`);
      }
    }

    return context;
  }

  /** 覆盖率采集节流：分组查询代价高，按 10 分钟粒度 tick */
  private shouldCollectCoverage(): boolean {
    if (this.lastCoverageAtMs === 0) return true;
    return Date.now() - this.lastCoverageAtMs >= COVERAGE_COLLECT_INTERVAL_MS;
  }

  /**
   * 中继「已启用但不可用」的原因（null = 就绪或未启用）。
   *
   * 顺序即排查顺序：开关 → 客户端 → 账号 → 目标群 → 源群可读 → Bot 可接收。
   */
  private describeRelayNotReady(capability: RelayCapabilitySnapshot): string | null {
    if (!capability.relayEnabledByConfig) return null;
    if (!capability.userClientAvailable) {
      return `MTProto 客户端不可用（${capability.userClientUnavailableReason ?? '未知原因'}）`;
    }
    if (capability.enabledAuthorizedUserCount <= 0) return '没有「已授权且启用」的用户账号';
    if (!capability.resolvedTargetChatIdPreview) {
      return '未解析到中继目标群（需配置并启用镜像规则目标群）';
    }
    if (capability.sourceChatReadable === 'failed') return '源群对用户账号不可读';
    if (capability.botsCanReceiveRelay === 'failed') {
      return '目标群内存在 Bot 未加入或未关闭隐私模式（中继消息无法被认领）';
    }
    return null;
  }

  private describe(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 200);
  }

  /** 采集 → 计算增量 → 创建告警（间隔调用；任何失败都不得影响主链路） */
  async runOnce(): Promise<void> {
    if (!this.pool.isActive()) return;

    let snapshot: AccountPoolSnapshot;
    try {
      snapshot = this.pool.snapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`账号池快照采集失败（忽略）: ${message}`);
      return;
    }

    const delta = diffCounters(snapshot.counters, this.lastCounters);
    this.lastCounters = { ...snapshot.counters };

    // 先采集异步事实（能力快照 / 观测降级 / 大文件覆盖率），再走纯函数评估：
    // 这样评估逻辑可单测，采集失败也不会污染判定。
    const context = await this.collectContext();
    const evaluations = this.evaluate(snapshot, delta, context);
    if (evaluations.length === 0) return;
    if (!this.alertEngine) {
      this.logger.warn('账号池检测到异常状态，但告警引擎未装配，仅记录日志');
      for (const evaluation of evaluations) {
        this.logger.warn(`[${evaluation.ruleId}] ${evaluation.message}`);
      }
      return;
    }

    try {
      await this.alertEngine.createAlerts(evaluations);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`账号池告警创建失败（忽略）: ${message}`);
    }
  }
}
