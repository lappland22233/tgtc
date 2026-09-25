import { Injectable } from '@nestjs/common';
import { MirrorExecutionResult } from './telegram-mirror.types';

/**
 * 镜像运行指标（进程内计数，单实例语义；供后台概览与告警判定）。
 *
 * 只有 `userCopyCount` 一种执行计数：副本扩散**只有**「用户账号从主群服务端转发到镜像群」
 * 这一条链路，不存在字节二次上传，因此没有上传字节/上传次数/降级比例之类的指标。
 */
export interface MirrorMetricsSnapshot {
  tasksQueued: number;
  tasksSucceeded: number;
  tasksFailed: number;
  tasksBlocked: number;
  tasksRetried: number;
  /** 用户账号服务端转发成功次数（字节二次传输恒为 0） */
  userCopyCount: number;
}

export type MirrorMetricKey = keyof MirrorMetricsSnapshot;

/**
 * 镜像指标采集。
 *
 * 为什么用进程内计数而不是每次聚合数据库：概览接口与告警判定按分钟级周期调用，
 * 全表聚合在任务量大时成本不可忽略；进程内计数只用于「运行态势」，
 * 权威事实（任务状态、错误码）仍以数据库为准。
 */
@Injectable()
export class TelegramMirrorMetricsService {
  private readonly counters: MirrorMetricsSnapshot = {
    tasksQueued: 0,
    tasksSucceeded: 0,
    tasksFailed: 0,
    tasksBlocked: 0,
    tasksRetried: 0,
    userCopyCount: 0,
  };

  bump(key: MirrorMetricKey, delta = 1): void {
    this.counters[key] += delta;
  }

  /** 记录一次成功执行 */
  recordSuccess(result: MirrorExecutionResult): void {
    this.counters.tasksSucceeded += 1;
    if (result.mode === 'user_copy') this.counters.userCopyCount += 1;
  }

  snapshot(): MirrorMetricsSnapshot {
    return { ...this.counters };
  }
}
