import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bull';

/**
 * 队列列表注入 token。
 *
 * 由 `BullQueueModule` 按 `QUEUE_NAMES`（队列注册的单一事实来源）逐队列
 * `getQueueToken(name)` 收集后以数组注入，避免在此硬编码重复的队列清单。
 * 数组注入也让单元测试可以直接构造 mock 队列实例。
 */
export const QUEUE_FAILURE_HOOK_QUEUES = Symbol('QUEUE_FAILURE_HOOK_QUEUES');

/**
 * 统一失败事件钩子（PERF-B-105 / OPS-006）。
 *
 * 背景：全仓此前没有任何 `OnQueueFailed` / `queue.on('failed')` 监听，队列任务
 * 在耗尽重试后静默进入 failed，只能靠人工翻 Redis 才能发现。
 *
 * 职责边界（只观测，不介入）：
 * - 仅注册 `failed` 事件监听并输出结构化单行日志；
 * - **不修改**任何 processor 内部的 try/catch、重试次数与退避策略，不做重试/清理等决策；
 * - **不输出 job.data 全文**（可能含 fileId、token、payload 等敏感字段），
 *   只输出：队列名 / jobId / job 名 / 已尝试次数 / 单行化并截断的错误摘要。
 */
@Injectable()
export class QueueFailureHookService implements OnModuleInit {
  /** 错误摘要截断上限（字符）：避免超长错误信息刷屏 */
  private static readonly MAX_ERROR_SUMMARY_LENGTH = 300;

  private readonly logger = new Logger(QueueFailureHookService.name);

  constructor(
    @Inject(QUEUE_FAILURE_HOOK_QUEUES) private readonly queues: Queue[],
  ) {}

  onModuleInit(): void {
    for (const queue of this.queues) {
      // 每个队列固定一个监听：观测该队列所有 job name 的最终失败
      queue.on('failed', (job, error) => this.logFailure(queue.name, job, error));
    }
  }

  /** 仅记录脱敏摘要；调用方保证不在此处做任何重试/失败决策 */
  private logFailure(queueName: string, job: Job, error: unknown): void {
    this.logger.error(
      `队列任务失败 queue=${queueName} jobId=${job?.id ?? 'unknown'} ` +
        `name=${job?.name ?? 'unknown'} attemptsMade=${job?.attemptsMade ?? 0} ` +
        `error=${this.summarizeError(error)}`,
    );
  }

  /** 错误摘要单行化（防日志注入/刷屏）并截断到 300 字符 */
  private summarizeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error ?? '');
    const singleLine = raw.replace(/\s+/g, ' ').trim();
    return singleLine.length > QueueFailureHookService.MAX_ERROR_SUMMARY_LENGTH
      ? singleLine.slice(0, QueueFailureHookService.MAX_ERROR_SUMMARY_LENGTH)
      : singleLine;
  }
}
