import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, MoreThanOrEqual, Repository } from 'typeorm';
import { AlertEngineService } from '../alert/alert-engine.service';
import { AlertRuleEvaluation } from '../alert/alert.rules';
import { AlertLevel } from '../common/entities/alert.entity';
import { TelegramMirrorTask } from '../common/entities/telegram-mirror-task.entity';
import { TelegramAccountFeatureService } from '../telegram-accounts/telegram-account-feature.service';
import { TelegramMirrorConfigService } from './telegram-mirror-config.service';

/**
 * 镜像告警阈值（**保守默认值**）。
 * 必须在预发布基线测试后冻结并写入灰度记录，不允许凭感觉放宽。
 */
export const MIRROR_ALERT_THRESHOLDS = {
  /** 连续失败任务数达到该值告警 */
  failureStreak: 3,
  /** 24h 成功率下限（样本量达标才判定） */
  successRateFloor: 0.8,
  /** 成功率判定的最小样本量 */
  minSampleSize: 5,
  /** 队列积压（queued + retrying）上限 */
  queueBacklog: 50,
  /** 「主文件成功但备份长期未完成」的分钟阈值 */
  stalledMinutes: 30,
} as const;

/**
 * 镜像任务的可观测告警。
 *
 * 判定口径全部来自**任务事实表**（状态、错误码、时间），不依赖内存计数做事实判断，
 * 只有「降级比例」使用进程内计数（重启后归零属预期，不产生误报）。
 * 告警正文只含内部 ID、脱敏名称、错误分类与数量，绝不含 Token / session / 完整 URL。
 */
@Injectable()
export class TelegramMirrorAlertService {
  private readonly logger = new Logger(TelegramMirrorAlertService.name);

  constructor(
    @InjectRepository(TelegramMirrorTask)
    private readonly tasks: Repository<TelegramMirrorTask>,
    private readonly engine: AlertEngineService,
    // 可选依赖：未装配时只跳过「镜像已开启但无启用规则」这一条判定（其余判定不受影响）。
    // 必须显式 `@Inject(X)`：`X | null` 联合类型发出的是 `Object`，
    // 否则 `@Optional()` 会把解析失败静默降级成 `null`。
    @Optional() @Inject(TelegramMirrorConfigService)
    private readonly config: TelegramMirrorConfigService | null = null,
    @Optional() @Inject(TelegramAccountFeatureService)
    private readonly feature: TelegramAccountFeatureService | null = null,
  ) {}

  async runOnce(): Promise<void> {
    try {
      const evaluations = await this.evaluate();
      if (evaluations.length > 0) await this.engine.createAlerts(evaluations);
    } catch (error) {
      // 告警失败不得影响镜像主链路
      this.logger.warn(`镜像告警评估失败（忽略，下轮重试）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async evaluate(): Promise<AlertRuleEvaluation[]> {
    const evaluations: AlertRuleEvaluation[] = [];
    const dayAgo = new Date(Date.now() - 24 * 3600_000);
    const hourAgo = new Date(Date.now() - 3600_000);

    const [recent, lastDaySucceeded, lastDayFailed, lastDayBlocked, pending] = await Promise.all([
      this.tasks.find({ order: { createdAt: 'DESC' }, take: 20 }),
      this.tasks.count({ where: { status: 'succeeded', createdAt: MoreThanOrEqual(dayAgo) } }),
      this.tasks.count({ where: { status: 'failed', createdAt: MoreThanOrEqual(dayAgo) } }),
      this.tasks.count({ where: { status: 'blocked', createdAt: MoreThanOrEqual(dayAgo) } }),
      this.tasks.find({ where: [{ status: 'queued' }, { status: 'retrying' }, { status: 'running' }] }),
    ]);

    // 1) 连续失败
    let streak = 0;
    for (const task of recent) {
      if (task.status === 'failed' || task.status === 'blocked') streak += 1;
      else break;
    }
    if (streak >= MIRROR_ALERT_THRESHOLDS.failureStreak) {
      evaluations.push({
        ruleId: 'MIRROR_FAILURE_STREAK',
        level: AlertLevel.CRITICAL,
        title: '镜像连续失败',
        message: `最近连续 ${streak} 个镜像任务失败/阻塞（阈值 ${MIRROR_ALERT_THRESHOLDS.failureStreak}），请检查账号权限与规则配置`,
        context: {
          streak,
          lastErrorCode: recent[0]?.lastErrorCode ?? null,
          lastErrorSummary: recent[0]?.lastErrorSummary ?? null,
        },
      });
    }

    // 2) 成功率偏低（样本量达标才判定）
    const sample = lastDaySucceeded + lastDayFailed + lastDayBlocked;
    if (sample >= MIRROR_ALERT_THRESHOLDS.minSampleSize) {
      const rate = lastDaySucceeded / sample;
      if (rate < MIRROR_ALERT_THRESHOLDS.successRateFloor) {
        evaluations.push({
          ruleId: 'MIRROR_SUCCESS_RATE_LOW',
          level: AlertLevel.WARNING,
          title: '镜像备份成功率偏低',
          message: `24h 镜像成功率 ${(rate * 100).toFixed(1)}%（阈值 ${MIRROR_ALERT_THRESHOLDS.successRateFloor * 100}%，样本 ${sample}）`,
          context: { rate, sample, succeeded: lastDaySucceeded, failed: lastDayFailed, blocked: lastDayBlocked },
        });
      }
    }

    // 3) 用户账号 session 失效
    const sessionFailures = await this.tasks.find({
      where: { status: 'blocked', lastErrorCode: 'user_session_invalid', updatedAt: MoreThanOrEqual(hourAgo) },
      take: 20,
    });
    if (sessionFailures.length > 0) {
      evaluations.push({
        ruleId: 'MIRROR_USER_SESSION_EXPIRED',
        level: AlertLevel.WARNING,
        title: '镜像用户账号 session 失效',
        message: `近 1 小时有 ${sessionFailures.length} 个镜像任务因用户账号 session 失效而阻塞，请在后台重新授权`,
        context: { count: sessionFailures.length, taskIds: sessionFailures.map((task) => task.id).slice(0, 10) },
      });
    }

    // 4) 备份群权限丢失
    const permissionFailures = await this.tasks.find({
      where: [
        { status: 'blocked', lastErrorCode: 'target_permission_denied', updatedAt: MoreThanOrEqual(hourAgo) },
        { status: 'blocked', lastErrorCode: 'user_permission_denied', updatedAt: MoreThanOrEqual(hourAgo) },
      ],
      take: 20,
    });
    if (permissionFailures.length > 0) {
      evaluations.push({
        ruleId: 'MIRROR_TARGET_PERMISSION_LOST',
        level: AlertLevel.CRITICAL,
        title: '镜像备份群权限丢失',
        message: `近 1 小时有 ${permissionFailures.length} 个镜像任务因权限不足阻塞，请检查备份群成员与发帖权限`,
        context: { count: permissionFailures.length, taskIds: permissionFailures.map((task) => task.id).slice(0, 10) },
      });
    }

    // 5) 队列积压
    if (pending.length >= MIRROR_ALERT_THRESHOLDS.queueBacklog) {
      evaluations.push({
        ruleId: 'MIRROR_QUEUE_BACKLOG',
        level: AlertLevel.WARNING,
        title: '镜像任务队列积压',
        message: `当前有 ${pending.length} 个镜像任务排队/重试中（阈值 ${MIRROR_ALERT_THRESHOLDS.queueBacklog}）`,
        context: { pending: pending.length },
      });
    }

    // 6) 主文件成功但备份长期未完成
    const stalledCutoff = Date.now() - MIRROR_ALERT_THRESHOLDS.stalledMinutes * 60_000;
    const stalled = pending.filter((task) => new Date(task.createdAt).getTime() < stalledCutoff);
    if (stalled.length > 0) {
      evaluations.push({
        ruleId: 'MIRROR_BACKUP_STALLED',
        level: AlertLevel.WARNING,
        title: '主文件成功但备份长期未完成',
        message: `有 ${stalled.length} 个镜像任务超过 ${MIRROR_ALERT_THRESHOLDS.stalledMinutes} 分钟仍未完成，请检查账号可用性与队列消费者`,
        context: { count: stalled.length, oldestTaskId: stalled[stalled.length - 1]?.id ?? null },
      });
    }

    // 7) 主群环节失败（搬运到主群 / 主群配置），链路第一步就断了
    const anchorFailures = await this.tasks.find({
      where: [
        { status: 'blocked', lastErrorCode: Like('main_chat_%'), updatedAt: MoreThanOrEqual(hourAgo) },
        { status: 'blocked', lastErrorCode: 'source_message_unresolved', updatedAt: MoreThanOrEqual(hourAgo) },
      ],
      take: 20,
    });
    if (anchorFailures.length > 0) {
      evaluations.push({
        ruleId: 'MIRROR_MAIN_CHAT_UNAVAILABLE',
        level: AlertLevel.CRITICAL,
        title: '镜像主群搬运不可用',
        message: `近 1 小时有 ${anchorFailures.length} 个镜像任务因「主群搬运/主群配置」失败而阻塞，`
          + '请检查主群（源群）成员与发帖权限、Bot 凭据，以及所有启用规则的源群是否一致',
        context: {
          count: anchorFailures.length,
          lastErrorCode: anchorFailures[0]?.lastErrorCode ?? null,
          taskIds: anchorFailures.map((task) => task.id).slice(0, 10),
        },
      });
    }

    // 8) 镜像已开启但没有任何启用中的规则
    //    这是唯一一种「新文件不会有任何备份、且不会产生任何任务记录」的状态：
    //    触发层在没有启用规则时直接跳过（不建单），因此任务事实表里什么都看不到，
    //    必须由这里兜住，否则表现为「上传成功、后台全绿、实际零备份」。
    //    依赖故障（库/开关服务抖动）只跳过**这一条**判定：若让它冒泡出去，
    //    本轮已收集的连续失败、权限丢失、主群不可用等告警会一起被丢弃（静默）。
    if (this.config && this.feature) {
      try {
        if (await this.feature.isMirrorEnabled()) {
          const enabledRules = await this.config.listEnabledRules();
          if (enabledRules.length === 0) {
            evaluations.push({
              ruleId: 'MIRROR_NO_ENABLED_RULES',
              level: AlertLevel.CRITICAL,
              title: '镜像已开启但没有启用中的规则',
              message: '镜像功能开关已开启，但没有任何启用中的镜像规则：此后收到的文件不会有任何备份'
                + '（触发层直接跳过，也不会留下 blocked 任务记录），请在后台启用至少一条镜像规则',
              context: { enabledRules: 0 },
            });
          }
        }
      } catch (error) {
        this.logger.warn(
          `镜像启用规则判定失败（仅跳过本条判定，其余镜像告警照常上报）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return evaluations;
  }
}
