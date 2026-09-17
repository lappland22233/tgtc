import { Injectable, Logger, NotFoundException, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { FileCacheService } from './file-cache.service';
import { DownloadTask } from '../common/entities/download-task.entity';
import type { DownloadQueueReason } from './download-resource-coordinator.service';

/**
 * 下载任务服务（两阶段下载的第一阶段）
 *
 * 目的：把"能不能立刻下载"从原始下载 GET 上剥离出来，让前端在点击后立刻拿到
 * 真实的排队原因、近似队列位置与建议重试间隔，而不是让浏览器干等首字节。
 *
 * 设计说明：
 * - 任务本身**不持有流**：最终文件传输仍由既有下载端点（cookie 鉴权的同源 URL）完成，
 *   因此不引入第二套取流路径，也不影响访问计数与 Range 语义；
 * - 任务状态由「缓存命中 + 资源协调器只读探测」推导得出，只读探测不排队、不占预约，
 *   轮询不会影响真实调度；
 * - 队列中的等待由真实下载请求在协调器内完成（严格 FIFO、不抢占旧任务），
 *   前端在 `streamable` 后触发浏览器原生下载；
 * - 任务状态以内存为权威（与仓库"只支持单后端实例"的约束一致），同时落库一份最终状态：
 *   重启时把遗留的非终态任务标记为过期，避免前端拿旧 taskId 无限轮询；过期记录定时清理。
 */
export type DownloadTaskStatus = 'queued' | 'streamable' | 'cancelled' | 'expired';

export interface DownloadTaskView {
  taskId: string;
  status: DownloadTaskStatus;
  /** 排队原因：磁盘 / 上游回源 / 服务器负载（含缓存容量饱和） */
  queueReason?: DownloadQueueReason;
  /** 近似队列位置（1 = 队首） */
  queuePosition?: number;
  /** 建议的重试间隔（毫秒） */
  retryAfterMs?: number;
  expectedSize: number;
  /** 可以开始下载时给出的目标地址（同一授权域、同源 cookie 鉴权） */
  downloadUrl?: string;
  expiresAt: string;
  errorCode?: string;
  message?: string;
}

export interface CreateDownloadTaskInput {
  /** 归属键：`user:<id>` / `share:<摘要>`；用于防止跨用户读取任务状态 */
  ownerKey: string;
  /** 业务文件 id（同时作为缓存键） */
  fileId: string;
  contentVersion?: string | number;
  expectedSize: number;
  /** 最终下载地址（由调用方在完成权限校验后给出） */
  downloadUrl: string;
  /** 该任务是否会计入正式缓存逻辑容量 */
  countsTowardCache: boolean;
}

interface DownloadTaskRecord {
  id: string;
  ownerKey: string;
  fileId: string;
  contentVersion?: string | number;
  expectedSize: number;
  downloadUrl: string;
  countsTowardCache: boolean;
  status: DownloadTaskStatus;
  queueReason?: DownloadQueueReason;
  queuePosition?: number;
  retryAfterMs?: number;
  errorCode?: string;
  message?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** 已落库的状态快照（`status:queueReason:errorCode`），避免轮询期间反复写库 */
  persisted?: string;
}

/** 任务状态过期检查间隔（同时回收过期记录） */
const SWEEP_INTERVAL_MS = 60_000;

@Injectable()
export class DownloadTaskService implements OnApplicationShutdown, OnModuleInit {
  private readonly logger = new Logger(DownloadTaskService.name);
  private readonly tasks = new Map<string, DownloadTaskRecord>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly fileCacheService: FileCacheService,
    // 可选注入：持久化仅用于「重启后把未完成任务标记过期」与记录清理，
    // 缺失（单测/未启用数据库）时任务仍以内存态正常工作。
    @Optional()
    @InjectRepository(DownloadTask)
    private readonly taskRepository?: Repository<DownloadTask>,
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /**
   * 重启恢复：内存中的排队状态无法跨进程存活（预约、临时文件都随进程消失），
   * 因此把上一次进程遗留的非终态任务标记为过期，避免前端拿着旧 taskId 无限轮询。
   */
  async onModuleInit(): Promise<void> {
    if (!this.taskRepository) return;
    try {
      const result = await this.taskRepository.update(
        { status: 'queued' },
        { status: 'expired', errorCode: 'DOWNLOAD_TASK_EXPIRED' },
      );
      const stale = result.affected ?? 0;
      if (stale > 0) {
        this.logger.log(`重启恢复：已将 ${stale} 个遗留下载任务标记为过期`);
      }
    } catch (error) {
      this.logger.warn(`重启恢复下载任务失败（不影响下载功能）: ${(error as Error).message}`);
    }
  }

  /** 过期记录清理：删除保留期已过的任务行，避免表无界增长（每 30 分钟） */
  @Cron('*/30 * * * *')
  async cleanupExpiredTaskRecords(): Promise<void> {
    if (!this.taskRepository) return;
    try {
      const result = await this.taskRepository.delete({ expiresAt: LessThan(new Date()) });
      if ((result.affected ?? 0) > 0) {
        this.logger.debug(`清理下载任务记录 ${result.affected} 条`);
      }
    } catch (error) {
      this.logger.warn(`清理下载任务记录失败: ${(error as Error).message}`);
    }
  }

  /** 创建下载任务：立即给出可否下载 / 排队原因与位置 */
  create(input: CreateDownloadTaskInput): DownloadTaskView {
    const now = Date.now();
    const retentionMs = this.fileCacheService.downloadTaskRetentionMs;
    const record: DownloadTaskRecord = {
      id: randomUUID(),
      ownerKey: input.ownerKey,
      fileId: input.fileId,
      contentVersion: input.contentVersion,
      expectedSize: input.expectedSize,
      downloadUrl: input.downloadUrl,
      countsTowardCache: input.countsTowardCache,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + retentionMs,
    };
    this.tasks.set(record.id, record);
    this.evaluate(record);
    this.persistIfChanged(record);
    this.logger.debug(
      `下载任务创建: ${record.id} file=${record.fileId} status=${record.status}` +
      `${record.queueReason ? ` reason=${record.queueReason}` : ''}`,
    );
    return this.toView(record);
  }

  /** 查询任务状态（每次查询都重新评估队列情况） */
  refresh(taskId: string, ownerKey: string): DownloadTaskView {
    const record = this.requireOwned(taskId, ownerKey);
    this.evaluate(record);
    this.persistIfChanged(record);
    return this.toView(record);
  }

  /** 取消排队中的任务（已完成/已取消的任务幂等返回当前状态） */
  cancel(taskId: string, ownerKey: string): DownloadTaskView {
    const record = this.requireOwned(taskId, ownerKey);
    if (record.status === 'queued') {
      record.status = 'cancelled';
      record.message = '下载任务已取消';
      record.queueReason = undefined;
      record.queuePosition = undefined;
      record.retryAfterMs = undefined;
      record.updatedAt = Date.now();
    }
    this.persistIfChanged(record);
    return this.toView(record);
  }

  /** 当前活跃任务数（观测/测试） */
  get activeTaskCount(): number {
    return this.tasks.size;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    // 关闭时标记所有排队任务取消，避免前端在重启窗口无限等待
    for (const record of this.tasks.values()) {
      if (record.status === 'queued') {
        record.status = 'cancelled';
        record.message = '服务正在重启，下载任务已取消，请稍后重试';
      }
    }
    this.tasks.clear();
  }

  // ---------- 内部 ----------

  private requireOwned(taskId: string, ownerKey: string): DownloadTaskRecord {
    const record = this.tasks.get(taskId);
    // 归属不符也按不存在处理，避免通过 taskId 探测他人任务
    if (!record || record.ownerKey !== ownerKey) {
      throw new NotFoundException('下载任务不存在或已过期');
    }
    return record;
  }

  /** 依据缓存命中与只读资源探测推导任务状态 */
  private evaluate(record: DownloadTaskRecord): void {
    if (record.status === 'cancelled') return;
    record.updatedAt = Date.now();
    if (Date.now() > record.expiresAt) {
      record.status = 'expired';
      record.errorCode = 'DOWNLOAD_TASK_EXPIRED';
      record.message = '下载任务已过期，请重新发起下载';
      record.queueReason = undefined;
      record.queuePosition = undefined;
      record.retryAfterMs = undefined;
      return;
    }

    // 已发布缓存命中：无需任何新增磁盘占用，可直接下载
    if (this.fileCacheService.getCachedPath(record.fileId)) {
      this.markStreamable(record, '文件已就绪，正在开始下载');
      return;
    }

    const probe = this.fileCacheService.probeDownloadAdmission(record.expectedSize, {
      countsTowardCache: record.countsTowardCache,
    });
    if (probe.admitted) {
      this.markStreamable(record, '服务器资源可用，正在开始下载');
      return;
    }

    record.status = 'queued';
    record.errorCode = undefined;
    if (probe.structural) {
      // 结构性不可行（完整暂存放不下）：真实下载会降级为有界直通，因此仍可下载
      record.queueReason = 'server_load';
      record.queuePosition = undefined;
      record.retryAfterMs = probe.retryAfterMs;
      record.message = '文件较大，将以直通方式下载（不占用本地缓存）';
      return;
    }
    record.queueReason = probe.reason as DownloadQueueReason;
    record.queuePosition = probe.queuePosition;
    record.retryAfterMs = probe.retryAfterMs;
    record.message = this.queueMessage(record.queueReason, probe.queuePosition);
  }

  private markStreamable(record: DownloadTaskRecord, message: string): void {
    record.status = 'streamable';
    record.queueReason = undefined;
    record.queuePosition = undefined;
    record.retryAfterMs = undefined;
    record.errorCode = undefined;
    record.message = message;
  }

  private queueMessage(reason: DownloadQueueReason, position: number): string {
    if (reason === 'upstream') return '服务器下载连接繁忙，任务已排队';
    if (reason === 'server_load') return '服务器当前下载负载较高，任务已排队，请稍后重试';
    const ahead = Math.max(0, position - 1);
    return ahead > 0
      ? `正在等待服务器释放磁盘空间，前面还有 ${ahead} 个任务`
      : '正在等待服务器释放磁盘空间';
  }

  private toView(record: DownloadTaskRecord): DownloadTaskView {
    return {
      taskId: record.id,
      status: record.status,
      expectedSize: record.expectedSize,
      expiresAt: new Date(record.expiresAt).toISOString(),
      ...(record.status === 'streamable' || record.status === 'queued'
        ? { downloadUrl: record.downloadUrl }
        : {}),
      ...(record.queueReason ? { queueReason: record.queueReason } : {}),
      ...(record.queuePosition !== undefined ? { queuePosition: record.queuePosition } : {}),
      ...(record.retryAfterMs !== undefined ? { retryAfterMs: record.retryAfterMs } : {}),
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      ...(record.message ? { message: record.message } : {}),
    };
  }

  // ---------- 持久化（fail-soft：写库失败绝不影响下载本身） ----------

  /** 状态快照有变化时才写库，避免轮询期间的写放大 */
  private persistIfChanged(record: DownloadTaskRecord): void {
    const snapshot = `${record.status}:${record.queueReason ?? ''}:${record.errorCode ?? ''}`;
    if (record.persisted === snapshot) return;
    record.persisted = snapshot;
    void this.persist(record);
  }

  private async persist(record: DownloadTaskRecord): Promise<void> {
    if (!this.taskRepository) return;
    try {
      await this.taskRepository.save({
        id: record.id,
        ownerKey: record.ownerKey,
        fileId: record.fileId,
        status: record.status,
        queueReason: record.queueReason ?? null,
        errorCode: record.errorCode ?? null,
        expectedSize: String(record.expectedSize),
        expiresAt: new Date(record.expiresAt),
      });
    } catch (error) {
      // 持久化是辅助能力（重启恢复 + 观测），失败只记录，不影响下载准入
      this.logger.debug(`下载任务持久化失败 ${record.id}: ${(error as Error).message}`);
    }
  }

  /** 回收过期任务记录，避免内存无界增长 */
  private sweep(): void {
    const now = Date.now();
    let removed = 0;
    for (const [id, record] of this.tasks) {
      const retentionMs = this.fileCacheService.downloadTaskRetentionMs;
      if (now > record.expiresAt + retentionMs) {
        this.tasks.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      this.logger.debug(`回收过期下载任务 ${removed} 个（剩余 ${this.tasks.size}）`);
    }
  }
}
