import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { IsNull, Repository } from 'typeorm';
import { UpdateTask, UpdateTaskStatus } from '../common/entities/update-task.entity';
import {
  assertTransition,
  isCancellableStatus,
  isTerminalStatus,
  UpdateStateTransitionError,
} from './update-state-machine';

export interface CreateUpdateTaskParams {
  requestedBy: string;
  currentVersion: string;
  targetVersion: string;
  releaseId: number;
  releaseTag: string;
  metadata?: Record<string, unknown> | null;
}

export type CreateTaskResult =
  | { task: UpdateTask; conflict?: undefined }
  | { conflict: UpdateTask; task?: undefined };

/** 心跳超过该时长视为执行器失联（服务重启恢复判断） */
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

/**
 * 更新任务持久化服务：活动槽位抢占、状态推进、安全取消与重启恢复。
 *
 * - 全局单活动任务由 isActive 部分唯一索引兜底，服务层在插入冲突时显式返回冲突。
 * - 状态推进使用乐观条件更新（where status=old），并发修改会显式失败而非静默覆盖。
 * - 服务启动时对非终态任务做保守恢复：绝不盲目重跑执行器。
 */
@Injectable()
export class UpdateTaskService implements OnModuleInit {
  private readonly logger = new Logger(UpdateTaskService.name);

  constructor(
    @InjectRepository(UpdateTask)
    private readonly repository: Repository<UpdateTask>,
  ) {}

  async findActiveTask(): Promise<UpdateTask | null> {
    return this.repository.findOne({ where: { isActive: true } });
  }

  async findTask(taskId: string): Promise<UpdateTask | null> {
    return this.repository.findOne({ where: { taskId } });
  }

  async listTasks(limit = 10): Promise<UpdateTask[]> {
    const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 50 ? limit : 10;
    return this.repository.find({
      order: { createdAt: 'DESC' },
      take: safeLimit,
    });
  }

  /**
   * 创建新任务并抢占活动槽位。已存在活动任务时返回 conflict（含当前活动任务）。
   * 并发下唯一索引兜底：插入失败后重新查询活动任务作为冲突方返回。
   */
  async createTask(params: CreateUpdateTaskParams): Promise<CreateTaskResult> {
    const existing = await this.findActiveTask();
    if (existing) return { conflict: existing };

    const task = this.repository.create({
      taskId: randomUUID(),
      requestedBy: params.requestedBy,
      currentVersion: params.currentVersion,
      targetVersion: params.targetVersion,
      releaseId: params.releaseId,
      releaseTag: params.releaseTag,
      status: 'queued',
      progress: 0,
      isActive: true,
      startedAt: new Date(),
      metadata: params.metadata ?? null,
    });
    try {
      return { task: await this.repository.save(task) };
    } catch (error) {
      const conflict = await this.findActiveTask();
      if (conflict) return { conflict };
      throw error;
    }
  }

  /**
   * 推进任务状态。使用条件更新保证并发安全；终态自动释放活动槽位。
   */
  async transitionTask(
    task: UpdateTask,
    to: UpdateTaskStatus,
    patch: Partial<Pick<UpdateTask, 'progress' | 'errorCode' | 'errorSummary' | 'rollbackStatus' | 'heartbeatAt' | 'metadata'>> = {},
  ): Promise<UpdateTask> {
    assertTransition(task.status, to);
    const update: Record<string, unknown> = { status: to, ...patch };
    if (isTerminalStatus(to)) {
      update.isActive = false;
      update.finishedAt = new Date();
    }
    const result = await this.repository.update(
      { taskId: task.taskId, status: task.status },
      update,
    );
    if (!result.affected) {
      // 条件更新未命中：任务状态已被并发修改。重新加载后让调用方基于最新状态决策。
      const latest = await this.findTask(task.taskId);
      throw new UpdateStateTransitionError(task.status, latest?.status ?? to);
    }
    const updated = await this.findTask(task.taskId);
    if (!updated) throw new Error(`任务 ${task.taskId} 在状态更新后丢失`);
    Object.assign(task, updated);
    return updated;
  }

  /** 取消仍处于安全阶段（queued/downloading）的任务。 */
  async cancelTask(task: UpdateTask, errorCode = 'cancelled_by_operator'): Promise<UpdateTask> {
    if (!isCancellableStatus(task.status)) {
      throw new UpdateStateTransitionError(task.status, 'cancelled');
    }
    return this.transitionTask(task, 'cancelled', {
      errorCode,
      errorSummary: '操作者在安全阶段取消了更新任务',
      progress: task.progress,
    });
  }

  /** 直接刷新心跳时间（不经状态机；同状态内的可变字段更新）。 */
  async touchHeartbeat(taskId: string): Promise<void> {
    await this.repository.update({ taskId }, { heartbeatAt: new Date() });
  }

  /**
   * 服务启动恢复（不盲目重跑）：
   * - queued/downloading：任务尚未进入不可逆区，保留原状态供操作者取消或执行器认领；
   * - activating/restarting/health_checking：可能由"后端随升级被重启"造成，
   *   交由 UpdateRunnerService 基于运行版本与目标版本比对后收敛（成功或回退）；
   * - 其余非终态且心跳缺失：执行器下落不明，保守标记 rollback_pending 等待执行器/人工处理；
   * - 心跳新鲜的任务视为执行器仍在运行，不改动（由心跳同步修正展示态）。
   */
  async recoverInterruptedTasks(): Promise<void> {
    const activeTasks = await this.repository.find({ where: { isActive: true } });
    for (const task of activeTasks) {
      if (isTerminalStatus(task.status)) continue;
      const stale = !task.heartbeatAt
        || Date.now() - new Date(task.heartbeatAt).getTime() > HEARTBEAT_STALE_MS;
      if (!stale) continue;
      if (task.status === 'queued' || task.status === 'downloading') continue;
      if (task.status === 'activating' || task.status === 'restarting' || task.status === 'health_checking') {
        continue;
      }
      if (task.status === 'rollback_pending' || task.status === 'rolling_back') continue;
      try {
        await this.transitionTask(task, 'rollback_pending', {
          errorCode: 'runner_interrupted',
          errorSummary: '服务重启后执行器心跳缺失，已暂停自动流程等待人工确认',
          rollbackStatus: 'needed',
        });
        this.logger.warn(`更新任务 ${task.taskId} 在服务重启后处于盲区，已标记 rollback_pending`);
      } catch (error) {
        this.logger.warn(
          `更新任务 ${task.taskId} 恢复处理失败：${error instanceof Error ? error.message : '未知错误'}`,
        );
      }
    }
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.recoverInterruptedTasks();
    } catch (error) {
      // 恢复失败不阻塞应用启动；任务历史仍可查询。
      this.logger.warn(`更新任务启动恢复失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }
}

// IsNull 目前未使用（保留查询语义扩展点），避免误删常用导入。
void IsNull;
