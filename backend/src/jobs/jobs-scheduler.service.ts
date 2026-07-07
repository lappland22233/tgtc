import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { QUEUE_NAMES } from './bull-queue.module';

/**
 * 管理所有 Bull 定时任务调度
 * 使用 Bull Queue 的 repeatable jobs 替代 @nestjs/schedule @Cron 装饰器
 */
@Injectable()
export class JobsSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(JobsSchedulerService.name);

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
    await this.scheduleJobs();
  }

  private async scheduleJobs(): Promise<void> {
    try {
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

      // 每分钟聚合
      await this.metricsQueue.add(
        'aggregate-1min',
        {},
        {
          jobId: 'repeat:metrics:aggregate-1min',
          repeat: { cron: '* * * * *' },
          removeOnComplete: 100,
          removeOnFail: 50,
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
        },
      );

      this.logger.log('Bull 定时任务调度已启动');
    } catch (error) {
      this.logger.error(`Bull 任务调度初始化失败: ${(error as Error).message}`);
    }
  }
}
