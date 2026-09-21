import { Injectable } from '@nestjs/common';
import { MirrorExecutionResult } from './telegram-mirror.types';

/** 镜像运行指标（进程内计数，单实例语义；供后台概览与告警判定） */
export interface MirrorMetricsSnapshot {
  tasksQueued: number;
  tasksSucceeded: number;
  tasksFailed: number;
  tasksBlocked: number;
  tasksRetried: number;
  botUploadBytes: number;
  botUploadCount: number;
  userCopyCount: number;
  fallbackCount: number;
}

export type MirrorMetricKey = keyof MirrorMetricsSnapshot;

/**
 * 镜像指标采集。
 *
 * 为什么用进程内计数而不是每次聚合数据库：概览接口与告警判定按分钟级周期调用，
 * 全表聚合在任务量大时成本不可忽略；进程内计数只用于「运行态势」，
 * 权威事实（任务状态、错误码）仍以数据库为准。**
 */
@Injectable()
export class TelegramMirrorMetricsService {
  private readonly counters: MirrorMetricsSnapshot = {
    tasksQueued: 0,
    tasksSucceeded: 0,
    tasksFailed: 0,
    tasksBlocked: 0,
    tasksRetried: 0,
    botUploadBytes: 0,
    botUploadCount: 0,
    userCopyCount: 0,
    fallbackCount: 0,
  };

  bump(key: MirrorMetricKey, delta = 1): void {
    this.counters[key] += delta;
  }

  /** 记录一次成功执行（按实际模式与降级情况分别计数） */
  recordSuccess(result: MirrorExecutionResult): void {
    this.counters.tasksSucceeded += 1;
    if (result.mode === 'bot_upload') {
      this.counters.botUploadCount += 1;
      this.counters.botUploadBytes += Math.max(0, result.fileSize || 0);
    } else {
      this.counters.userCopyCount += 1;
    }
    if (result.fallbackApplied) this.counters.fallbackCount += 1;
  }

  snapshot(): MirrorMetricsSnapshot {
    return { ...this.counters };
  }

  /** 降级比例（无样本时为 0，避免「0/0」被误判为高降级） */
  fallbackRate(): number {
    const total = this.counters.tasksSucceeded + this.counters.tasksFailed + this.counters.tasksBlocked;
    return total > 0 ? this.counters.fallbackCount / total : 0;
  }
}
