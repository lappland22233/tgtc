import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { QUEUE_NAMES } from './bull-queue.module';

/**
 * 管理所有 Bull 定时任务调度
 * 使用 Bull Queue 的 repeatable jobs 替代 @nestjs/schedule @Cron 装饰器
 *
 * 鲁棒性：启动时若 Redis 不可用，调度会失败。此处加入延迟重试机制——
 * 每隔 RETRY_INTERVAL_MS 检查是否已成功调度，未调度则重试，直到成功为止，
 * 避免「启动时 Redis 抖动 → 所有定时任务永不调度且无告警」的问题。
 */
@Injectable()
export class JobsSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsSchedulerService.name);

  /** 调度失败后的重试间隔（毫秒） */
  private static readonly RETRY_INTERVAL_MS = 30 * 1000;

  /** 是否已成功完成调度 */
  private scheduled = false;
  /** 重试定时器 */
  private retryTimer: NodeJS.Timeout | null = null;
  private schedulingPromise: Promise<void> | null = null;
  private readonly commandDeadlineMs = 15_000;

  constructor(
    @InjectQueue(QUEUE_NAMES.METRICS_AGGREGATION)
    private metricsQueue: Queue,
    @InjectQueue(QUEUE_NAMES.ATTACK_DETECTION)
    private attackDetectionQueue: Queue,
    @InjectQueue(QUEUE_NAMES.ALERT_EVALUATION)
    private alertEvaluationQueue: Queue,
    @InjectQueue(QUEUE_NAMES.BASELINE_CALCULATION)
    private baselineCalculationQueue: Queue,
    @InjectQueue(QUEUE_NAMES.DATA_ARCHIVAL)
    private dataArchivalQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureScheduled();
  }

  onModuleDestroy(): void {
    this.clearRetryTimer();
  }

  /** 尝试调度；失败则降级启动并在后台周期性重试。 */
  private async ensureScheduled(): Promise<void> {
    try {
      await this.runScheduleSingleFlight();
      this.scheduled = true;
      this.clearRetryTimer();
      this.logger.log('Bull 定时任务调度已启动');
    } catch (error) {
      this.scheduled = false;
      this.logger.error(
        `Bull 任务调度初始化失败: ${(error as Error).message}，` +
        `应用将以降级状态启动并在 ${JobsSchedulerService.RETRY_INTERVAL_MS / 1000}s 后自动重试`,
      );
      this.scheduleRetry();
    }
  }

  private runScheduleSingleFlight(): Promise<void> {
    if (this.schedulingPromise) return this.schedulingPromise;
    this.schedulingPromise = this.withDeadline(this.scheduleJobs(), this.commandDeadlineMs, 'Bull 调度命令超时')
      .finally(() => { this.schedulingPromise = null; });
    return this.schedulingPromise;
  }

  private withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${message}（${timeoutMs}ms）`)), timeoutMs);
      timer.unref?.();
      promise.then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
  }

  /** 启动周期性重试（每 30s 检查一次，未调度则重试） */
  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(async () => {
      if (this.scheduled) {
        this.clearRetryTimer();
        return;
      }
      try {
        await this.runScheduleSingleFlight();
        this.scheduled = true;
        this.clearRetryTimer();
        this.logger.log('Bull 定时任务调度已恢复（重试成功）');
      } catch (error) {
        this.logger.error(
          `Bull 任务调度重试仍失败: ${(error as Error).message}，` +
          `${JobsSchedulerService.RETRY_INTERVAL_MS / 1000}s 后继续重试`,
        );
      }
    }, JobsSchedulerService.RETRY_INTERVAL_MS);
    // 不阻止进程退出
    if (typeof this.retryTimer.unref === 'function') {
      this.retryTimer.unref();
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async scheduleJobs(): Promise<void> {
    // 精准清理已知的可重复任务（避免 obliterate 全清队列丢失活跃任务）
    const repeatJobs: Array<{ queue: Queue; name: string; cron: string }> = [
      { queue: this.metricsQueue, name: 'aggregate-1min', cron: '* * * * *' },
      { queue: this.attackDetectionQueue, name: 'detect-attacks', cron: '*/5 * * * *' },
      { queue: this.attackDetectionQueue, name: 'detect-anomalies', cron: '*/15 * * * *' },
      { queue: this.alertEvaluationQueue, name: 'evaluate-alerts', cron: '* * * * *' },
      { queue: this.baselineCalculationQueue, name: 'calculate-baseline', cron: '0 4 * * *' },
      { queue: this.dataArchivalQueue, name: 'archive-data', cron: '0 2 * * *' },
      { queue: this.dataArchivalQueue, name: 'weekly-report', cron: '0 9 * * 1' },
    ];

    for (const { queue, name, cron } of repeatJobs) {
      await queue.removeRepeatable(name, { cron });
    }

    // 每分钟聚合（timeout 防止 Telegram/DB 无响应时无限阻塞并发槽位）
    await this.metricsQueue.add(
      'aggregate-1min',
      {},
      {
        jobId: 'repeat:metrics:aggregate-1min',
        repeat: { cron: '* * * * *' },
        removeOnComplete: 100,
        removeOnFail: 50,
        timeout: 50 * 1000,
        attempts: 2,
        backoff: { type: 'exponential', delay: 5 * 1000 },
      },
    );

    // 每 5 分钟攻击检测
    await this.attackDetectionQueue.add(
      'detect-attacks',
      {},
      {
        jobId: 'repeat:attack:detect-attacks',
        repeat: { cron: '*/5 * * * *' },
        removeOnComplete: 50,
        removeOnFail: 25,
        timeout: 4 * 60 * 1000,
        attempts: 2,
        backoff: { type: 'exponential', delay: 10 * 1000 },
      },
    );

    // 每 15 分钟异常行为检测
    await this.attackDetectionQueue.add(
      'detect-anomalies',
      {},
      {
        jobId: 'repeat:attack:detect-anomalies',
        repeat: { cron: '*/15 * * * *' },
        removeOnComplete: 20,
        removeOnFail: 10,
        timeout: 4 * 60 * 1000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 15 * 1000 },
      },
    );

    // 每 1 分钟告警评估（Phase 4 激活）
    await this.alertEvaluationQueue.add(
      'evaluate-alerts',
      {},
      {
        jobId: 'repeat:alert:evaluate-alerts',
        repeat: { cron: '* * * * *' },
        removeOnComplete: 100,
        removeOnFail: 50,
        timeout: 55 * 1000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10 * 1000 },
      },
    );

    // 每日 04:00 基线计算（Phase 5 激活）
    await this.baselineCalculationQueue.add(
      'calculate-baseline',
      {},
      {
        jobId: 'repeat:baseline:calculate-baseline',
        repeat: { cron: '0 4 * * *' },
        removeOnComplete: 10,
        removeOnFail: 5,
        attempts: 2,
        backoff: { type: 'exponential', delay: 30 * 1000 },
      },
    );

    // 每日 02:00 数据归档
    await this.dataArchivalQueue.add(
      'archive-data',
      {},
      {
        jobId: 'repeat:archival:archive-data',
        repeat: { cron: '0 2 * * *' },
        removeOnComplete: 10,
        removeOnFail: 5,
        attempts: 2,
        backoff: { type: 'exponential', delay: 30 * 1000 },
      },
    );

    // 每周一 09:00 周报
    await this.dataArchivalQueue.add(
      'weekly-report',
      {},
      {
        jobId: 'repeat:archival:weekly-report',
        repeat: { cron: '0 9 * * 1' },
        removeOnComplete: 5,
        removeOnFail: 3,
        attempts: 2,
        backoff: { type: 'exponential', delay: 30 * 1000 },
      },
    );

  }
}
