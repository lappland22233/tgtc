import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { existsSync } from 'fs';
import * as path from 'path';
import { AlertLevel } from '../common/entities/alert.entity';
import { AlertEngineService } from './alert-engine.service';
import { QUEUE_NAMES } from '../jobs/bull-queue.module';
import { freeDiskBytes } from '../file/cache-disk-manager';
import { pendingUploadDirectory } from '../file/pending-upload';

/** 磁盘余量告警阈值：低于 2 GiB 即告警（缓存与上传暂存常共用同一卷） */
const DISK_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
/** 上传/校验队列 waiting+delayed 阈值 */
const UPLOAD_QUEUE_BACKLOG = 200;
/** 上传/校验队列 failed 阈值 */
const UPLOAD_QUEUE_FAILED = 50;
/** 指标聚合每分钟一跑，waiting 堆积即说明消费者不前进 */
const SCHEDULER_BACKLOG = 10;
/** 队列查询超时：Redis 挂起时不得拖住进程内观测 */
const QUEUE_PROBE_TIMEOUT_MS = 5000;

type JobCounts = { waiting?: number; active?: number; delayed?: number; failed?: number };

/**
 * 运维基础设施观测（C-16）：磁盘余量、上传/校验队列积压、调度停摆。
 *
 * **刻意用进程内 @Cron 而不是 Bull repeatable**：Redis 挂掉时 Bull 全部任务静默停摆，
 * 若观测本身也挂在队列上就永远看不到故障——这三条告警是 dead-man switch，
 * 必须独立于被观测的基础设施。后续统一调度机制（A-09）时本服务须保留进程内驱动。
 *
 * 告警引擎写库同样可能失败；此处只记日志，不抛错中断观测循环。
 */
@Injectable()
export class OpsObservationService {
  private readonly logger = new Logger(OpsObservationService.name);

  constructor(
    private readonly alertEngine: AlertEngineService,
    @InjectQueue(QUEUE_NAMES.FILE_UPLOAD) private readonly fileUploadQueue: Queue,
    @InjectQueue(QUEUE_NAMES.FILE_VERIFY) private readonly fileVerifyQueue: Queue,
    @InjectQueue(QUEUE_NAMES.METRICS_AGGREGATION) private readonly metricsQueue: Queue,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async observe(): Promise<void> {
    await Promise.all([
      this.observeDisk().catch((err) => this.logger.warn(`磁盘余量观测失败：${(err as Error).message}`)),
      this.observeQueues().catch((err) => this.logger.warn(`队列观测失败：${(err as Error).message}`)),
    ]);
  }

  private async observeDisk(): Promise<void> {
    const targets = [
      { name: '缓存盘', dir: path.resolve(process.cwd(), 'tmp', 'Cache') },
      { name: '上传暂存盘', dir: pendingUploadDirectory() },
    ];
    const low: Array<{ name: string; dir: string; freeBytes: number }> = [];
    const unprobeable: string[] = [];
    for (const target of targets) {
      // 目录尚未创建（全新部署）时跳过，避免误报
      if (!existsSync(target.dir)) continue;
      const free = freeDiskBytes(target.dir);
      if (free === null) {
        unprobeable.push(target.name);
      } else if (free < DISK_MIN_FREE_BYTES) {
        low.push({ ...target, freeBytes: free });
      }
    }
    if (!low.length && !unprobeable.length) return;

    const detail = low
      .map((item) => `${item.name}剩余 ${(item.freeBytes / 1024 / 1024 / 1024).toFixed(2)}GiB`)
      .join('；');
    const message = [
      detail ? `${detail}，低于阈值 ${(DISK_MIN_FREE_BYTES / 1024 / 1024 / 1024).toFixed(0)}GiB` : '',
      unprobeable.length ? `无法探测：${unprobeable.join('、')}（statfs 失败，按空间不足处理）` : '',
    ].filter(Boolean).join('；');

    await this.alertEngine.createAlerts([{
      ruleId: 'OPS_DISK_LOW',
      level: AlertLevel.CRITICAL,
      title: '缓存/上传盘余量不足',
      message: `${message}。磁盘打满会让上传写入 ENOSPC、缓存构建失败并降级为直通，请立即清理或扩容`,
      context: { low, unprobeable, thresholdBytes: DISK_MIN_FREE_BYTES },
    }]);
  }

  private async observeQueues(): Promise<void> {
    const probes: Array<{ key: string; queue: Queue }> = [
      { key: QUEUE_NAMES.FILE_UPLOAD, queue: this.fileUploadQueue },
      { key: QUEUE_NAMES.FILE_VERIFY, queue: this.fileVerifyQueue },
      { key: QUEUE_NAMES.METRICS_AGGREGATION, queue: this.metricsQueue },
    ];
    const results = await Promise.all(probes.map(async (probe) => ({
      key: probe.key,
      counts: await this.probeCounts(probe.queue),
    })));

    // Redis 不可用 / 查询挂起：全部定时与异步任务已停摆，而 /api/health 之外无人可见
    const unreachable = results.filter((r) => r.counts === null).map((r) => r.key);
    if (unreachable.length) {
      await this.alertEngine.createAlerts([{
        ruleId: 'OPS_SCHEDULER_STALLED',
        level: AlertLevel.CRITICAL,
        title: '任务调度停摆',
        message: `无法查询队列状态：${unreachable.join('、')}。Redis 不可用或连接挂起，`
          + '上传、镜像、指标聚合与告警评估等全部 Bull 任务已停止消费，请立即检查 Redis',
        context: { unreachable, timeoutMs: QUEUE_PROBE_TIMEOUT_MS },
      }]);
      return;
    }

    const byKey = new Map(results.map((r) => [r.key, r.counts as JobCounts]));
    const pending = (c: JobCounts) => (c.waiting ?? 0) + (c.delayed ?? 0);

    const backlogged = [QUEUE_NAMES.FILE_UPLOAD, QUEUE_NAMES.FILE_VERIFY]
      .map((key) => ({ key, counts: byKey.get(key) ?? {} }))
      .filter(({ counts }) => pending(counts) > UPLOAD_QUEUE_BACKLOG || (counts.failed ?? 0) > UPLOAD_QUEUE_FAILED);
    if (backlogged.length) {
      await this.alertEngine.createAlerts([{
        ruleId: 'OPS_UPLOAD_QUEUE_BACKLOG',
        level: AlertLevel.WARNING,
        title: '上传/校验队列积压',
        message: backlogged
          .map(({ key, counts }) => `${key} 等待 ${pending(counts)}、失败 ${counts.failed ?? 0}`)
          .join('；')
          + `。阈值：等待 ${UPLOAD_QUEUE_BACKLOG} / 失败 ${UPLOAD_QUEUE_FAILED}；`
          + '请检查 Worker 是否存活、存储后端容量与 Telegram 凭据',
        context: {
          backlogged: backlogged.map(({ key, counts }) => ({ key, ...counts })),
          thresholds: { waiting: UPLOAD_QUEUE_BACKLOG, failed: UPLOAD_QUEUE_FAILED },
        },
      }]);
    }

    // 指标聚合每分钟一跑：waiting 堆积说明消费者不前进（进程存活但调度卡死）
    const metricsCounts = byKey.get(QUEUE_NAMES.METRICS_AGGREGATION) ?? {};
    if (pending(metricsCounts) > SCHEDULER_BACKLOG) {
      await this.alertEngine.createAlerts([{
        ruleId: 'OPS_SCHEDULER_STALLED',
        level: AlertLevel.CRITICAL,
        title: '任务调度停摆',
        message: `指标聚合队列等待 ${pending(metricsCounts)} 个任务（阈值 ${SCHEDULER_BACKLOG}）。`
          + '该队列每分钟应被消费一次，堆积说明调度器或 Worker 已停止前进',
        context: { queue: QUEUE_NAMES.METRICS_AGGREGATION, ...metricsCounts, threshold: SCHEDULER_BACKLOG },
      }]);
    }
  }

  private async probeCounts(queue: Queue): Promise<JobCounts | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        queue.getJobCounts() as Promise<JobCounts>,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), QUEUE_PROBE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}