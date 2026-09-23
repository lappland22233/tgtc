import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AlertLevel } from '../common/entities/alert.entity';
import { AlertEngineService } from '../alert/alert-engine.service';
import { AlertRuleEvaluation } from '../alert/alert.rules';
import { AccountPoolCounters, AccountPoolSnapshot } from './telegram-account-pool.types';
import { TelegramAccountPoolService } from './telegram-account-pool.service';

/**
 * 回退率告警阈值（**预发布基线测试后冻结**；当前为保守默认值，避免噪声）。
 * 采样不足（< MIN_SAMPLES 次选号）时不判回退率，防止低流量下误报。
 */
const FALLBACK_RATE_WARNING = 0.2;
const FALLBACK_RATE_MIN_SAMPLES = 5;
/** 单次采集窗口内「复制持续失败 / 回复失败 / 用户账号中继失败」的告警触发次数 */
const REPLICATION_FAILURE_BURST = 3;
const REPLY_FAILURE_BURST = 1;
const USER_RELAY_FAILURE_BURST = 3;

const COUNTER_KEYS: Array<keyof AccountPoolCounters> = [
  'selections',
  'failovers',
  'fallbacks',
  'unresolved',
  'replicationsOk',
  'replicationsFailed',
  'streamFailures',
  'replyFailures',
  'inboundRegistrationFailures',
  'userRelaysOk',
  'userRelaysFailed',
  'inboundBridgeMisses',
];

function zeroCounters(): AccountPoolCounters {
  return {
    selections: 0,
    failovers: 0,
    fallbacks: 0,
    unresolved: 0,
    replicationsOk: 0,
    replicationsFailed: 0,
    streamFailures: 0,
    replyFailures: 0,
    inboundRegistrationFailures: 0,
    userRelaysOk: 0,
    userRelaysFailed: 0,
    inboundBridgeMisses: 0,
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
 */
@Injectable()
export class TelegramAccountPoolAlertService {
  private readonly logger = new Logger(TelegramAccountPoolAlertService.name);
  private lastCounters: AccountPoolCounters = zeroCounters();

  constructor(
    private readonly pool: TelegramAccountPoolService,
    // 必须显式 `@Inject(X)`：`X | null` 联合类型发出的是 `Object`，
    // 否则 `@Optional()` 会把解析失败静默降级成 `null`（告警只写日志、永不落库）。
    @Optional() @Inject(AlertEngineService)
    private readonly alertEngine: AlertEngineService | null = null,
  ) {}

  /**
   * 状态评估（纯函数，便于单测）：返回本轮应触发但尚未创建的告警。
   * 账号池未生效时一律不告警（「未启用」不是异常）。
   */
  evaluate(snapshot: AccountPoolSnapshot, delta: AccountPoolCounters): AlertRuleEvaluation[] {
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

    if (delta.replicationsFailed >= REPLICATION_FAILURE_BURST) {
      evaluations.push({
        ruleId: 'BOT_POOL_REPLICATION_FAILING',
        level: AlertLevel.WARNING,
        title: 'Bot 副本扩散持续失败',
        message: `最近失败 ${delta.replicationsFailed} 次副本扩散（成功 ${delta.replicationsOk} 次）；`
          + '请检查目标账号的存储 Chat 是否存在、Bot 是否已被加入并具备发送权限。',
        context: { failed: delta.replicationsFailed, ok: delta.replicationsOk },
      });
    }

    if (delta.userRelaysFailed >= USER_RELAY_FAILURE_BURST) {
      evaluations.push({
        ruleId: 'BOT_POOL_USER_RELAY_FAILING',
        level: AlertLevel.WARNING,
        title: '用户账号中继持续失败',
        message: `最近失败 ${delta.userRelaysFailed} 次用户账号中继（成功 ${delta.userRelaysOk} 次）；`
          + '副本已自动回退到「逐账号二次上传」，但会出现上传流量放大。'
          + '请检查：user 账号是否已授权并启用、是否同时是源群与副本可见群成员、'
          + '以及副本可见群内每个 Bot 是否已关闭隐私模式或设为管理员。',
        context: { failed: delta.userRelaysFailed, ok: delta.userRelaysOk },
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

    return evaluations;
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

    const evaluations = this.evaluate(snapshot, delta);
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
