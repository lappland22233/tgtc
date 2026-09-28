import { Injectable, Logger, NotFoundException, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { FileCacheService } from './file-cache.service';
import { DownloadTask } from '../common/entities/download-task.entity';
import {
  DOWNLOAD_ERROR_CODES,
  DownloadResourceException,
  type DownloadQueueReason,
  type DownloadReservation,
} from './download-resource-coordinator.service';

/**
 * 下载任务服务（两阶段下载的第一阶段）
 *
 * 目的：把"能不能立刻下载"从原始下载 GET 上剥离出来，让前端在点击后立刻拿到
 * 真实的排队原因、近似队列位置与建议重试间隔，而不是让浏览器干等首字节。
 *
 * 设计说明：
 * - 任务**持有真实资源**：可立即准入时同步持有磁盘预约（`tryReserveDownloadNow`），
 *   需要等待时以异步 `reserve()` 进入真实 FIFO 队列；不再只做只读探测，
 *   否则"已排队"并不保证正文请求能拿到资源（历史上会出现排到队首后正文仍被抢占）。
 * - 任务仍**不持有流**：最终传输由既有下载端点（cookie 鉴权的同源 URL）完成，
 *   因此不引入第二套取流路径，也不影响访问计数与 Range 语义。
 * - **短时票据 + 原子消费**：资源就绪时签发一次性票据（追加在 `downloadUrl` 上），
 *   正文 GET 携带 `?taskTicket=` 时消费票据并把预约交接给该请求（`handOffToSession`），
 *   使正文请求的 `reserve()` 直接采用已持有的预约、不再重新排队。
 * - 结构性不可行（完整暂存放不下）时任务**立即变为可下载**并标记 `mode: 'direct'`：
 *   真实下载会降级为有界直通；历史缺陷是此时仍停在 `queued`，前端会一直轮询到过期。
 * - 任务状态以内存为权威（与仓库"只支持单后端实例"的约束一致），同时落库一份最终状态：
 *   重启时把遗留的非终态任务标记为过期，避免前端拿旧 taskId 无限轮询；过期记录定时清理。
 */
export type DownloadTaskStatus = 'queued' | 'streamable' | 'cancelled' | 'expired';

/** 传输模式：走正式缓存/临时暂存，或结构性不可行时的有界直通 */
export type DownloadTaskMode = 'cache' | 'direct';

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
  /**
   * 可以开始下载时给出的目标地址（同一授权域、同源 cookie 鉴权）。
   * 资源就绪时会带上一次性 `taskTicket`，正文请求凭它原子采用已持有的预约。
   */
  downloadUrl?: string;
  /** 一次性票据（仅资源就绪时给出；正文请求消费后失效） */
  ticket?: string;
  /** 票据过期时间（ISO 字符串） */
  ticketExpiresAt?: string;
  /** 传输模式：cache（缓存/临时暂存）或 direct（有界直通，不占本地缓存） */
  mode?: DownloadTaskMode;
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
  mode?: DownloadTaskMode;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** 已落库的状态快照（`status:queueReason:errorCode`），避免轮询期间反复写库 */
  persisted?: string;
  /** 任务真实持有的磁盘预约（资源就绪后由票据交接给正文请求） */
  reservation?: DownloadReservation;
  /** 等待预约时用于取消（任务取消 / 过期 / 服务关闭） */
  abortController?: AbortController;
  /** 一次性票据；正文请求消费后清空 */
  ticket?: string;
  ticketExpiresAt?: number;
  /** 预约是否已交接给正文请求（交接后不再撤销，取消也不再影响该次传输） */
  handedOff?: boolean;
}

/** 任务状态过期检查间隔（同时回收过期记录） */
const SWEEP_INTERVAL_MS = 60_000;
/** 票据有效期：也是正文请求采用交接预约的上限（与协调器 HANDOFF_TTL_MS 对齐） */
const TASK_TICKET_TTL_MS = 120_000;

@Injectable()
export class DownloadTaskService implements OnApplicationShutdown, OnModuleInit {
  private readonly logger = new Logger(DownloadTaskService.name);
  private readonly tasks = new Map<string, DownloadTaskRecord>();
  /** 票据索引：ticket → taskId（原子消费时立即删除） */
  private readonly ticketIndex = new Map<string, string>();
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

  /**
   * 创建下载任务：立即给出可否下载 / 排队原因与位置。
   *
   * - 缓存命中或探测确认可立即准入 → 同步持有真实磁盘预约并签发票据（保持同步返回 streamable）；
   * - 结构性不可行 → 立即 `streamable` + `mode: 'direct'`（真实下载走有界直通）；
   * - 其余 → 进入真实 FIFO 队列等待预约（异步），状态查询仍走只读探测。
   */
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
      abortController: new AbortController(),
    };
    this.tasks.set(record.id, record);
    this.evaluate(record);

    if (record.status === 'streamable' && !record.mode) {
      // 探测已确认可立即准入：顺手持有真实预约（不排队），保证正文请求真正拿得到资源
      const granted = this.tryHoldReservationNow(record);
      if (granted) {
        record.reservation = granted;
        this.issueTicket(record);
        record.message = '已为该任务预留磁盘空间，正在开始下载';
      }
    } else if (record.status === 'queued') {
      // 需要等待：以真实队列等待预约（等待期间仍可由用户取消）
      void this.acquireReservation(record);
    }

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
    // 预约已交接给正文请求：该次传输已开始，取消不再生效（避免中途砍掉下载）
    if (record.handedOff) return this.toView(record);
    if (record.status === 'queued' || record.status === 'streamable') {
      this.releaseResources(record, '用户取消');
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

  /**
   * 原子消费一次性票据（正文 GET 携带 `?taskTicket=` 时调用）。
   *
   * 校验归属/文件/有效期后，把任务持有的磁盘预约交接给同会话的正文请求，
   * 使其 `reserve()` 直接采用、不再重新排队。票据单次有效：无论成功与否都会失效。
   */
  consumeTicket(ticket: string, ownerKey: string, fileId: string): boolean {
    if (!ticket) return false;
    const taskId = this.ticketIndex.get(ticket);
    if (!taskId) return false;
    // 立刻失效，避免并发重放
    this.ticketIndex.delete(ticket);

    const record = this.tasks.get(taskId);
    if (!record) return false;
    const matches = record.ticket === ticket;
    const ticketExpiresAt = record.ticketExpiresAt;
    record.ticket = undefined;
    record.ticketExpiresAt = undefined;
    if (!matches || record.ownerKey !== ownerKey || record.fileId !== fileId) return false;
    // 票据过期后不得再消费：此时预约已被 evaluate() 释放，采用会导致「交接了不存在的资源」
    if (ticketExpiresAt !== undefined && Date.now() > ticketExpiresAt) return false;
    if (!record.reservation || !record.reservation.active) return false;

    const reservation = record.reservation;
    record.reservation = undefined;
    record.handedOff = true;
    record.updatedAt = Date.now();
    record.message = '资源已交给下载请求，正在传输';
    this.fileCacheService.handOffDownloadReservation(record.fileId, record.contentVersion, reservation);
    this.logger.debug(`下载任务票据已消费并交接预约: ${record.id} file=${record.fileId}`);
    return true;
  }

  /** 当前活跃任务数（观测/测试） */
  get activeTaskCount(): number {
    return this.tasks.size;
  }

  /** 当前持有的预约数（观测：应只包含尚未交接的自有预约） */
  get heldReservationCount(): number {
    let count = 0;
    for (const record of this.tasks.values()) {
      if (record.reservation) count++;
    }
    return count;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    // 关闭时释放全部持有的预约（含等待中的排队项），避免预约与上游租约残留
    for (const record of this.tasks.values()) {
      if (record.status === 'queued') {
        record.message = '服务正在重启，下载任务已取消，请稍后重试';
      }
      this.releaseResources(record, '服务关闭');
      if (record.status === 'queued') record.status = 'cancelled';
    }
    this.tasks.clear();
    this.ticketIndex.clear();
    // 回收交接池中尚未被采用的预约
    this.fileCacheService.purgeExpiredDownloadReservations();
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

  /** 同步尝试立即持有预约；不可立即满足时返回 null */
  private tryHoldReservationNow(record: DownloadTaskRecord): DownloadReservation | null {
    try {
      return this.fileCacheService.tryReserveDownloadNow(record.fileId, record.expectedSize, {
        contentVersion: record.contentVersion,
        countsTowardCache: record.countsTowardCache,
      });
    } catch (error) {
      // 探测与同步授予之间存在竞态（例如磁盘刚好被占满）：交由异步路径处理
      this.logger.debug(`同步持有下载预约失败（转异步排队）: ${(error as Error).message}`);
      return null;
    }
  }

  /** 异步真实排队等待预约；等待期间可被取消、过期或服务关闭打断 */
  private async acquireReservation(record: DownloadTaskRecord): Promise<void> {
    if (record.reservation || record.handedOff) return;
    if (record.status !== 'queued') return;
    try {
      const reservation = await this.fileCacheService.reserveDownload(record.fileId, record.expectedSize, {
        contentVersion: record.contentVersion,
        countsTowardCache: record.countsTowardCache,
        signal: record.abortController?.signal,
      });
      // 等待期间已被取消/过期/交接：立即归还，避免预约泄漏
      if (record.status !== 'queued' || Date.now() > record.expiresAt) {
        reservation.release();
        return;
      }
      record.reservation = reservation;
      this.issueTicket(record);
      this.markStreamable(record, '已为该任务预留磁盘空间，正在开始下载');
      this.persistIfChanged(record);
      this.logger.debug(`下载任务取得预约: ${record.id} file=${record.fileId}`);
    } catch (error) {
      if (record.status !== 'queued') return;
      // 结构性不可行（完整暂存放不下）→ 真实下载会降级直通，任务应立即可下载
      if (this.isStructuralRejection(error)) {
        record.mode = 'direct';
        this.markStreamable(record, '文件较大，将以直通方式下载（不占用本地缓存）');
        this.persistIfChanged(record);
        return;
      }
      const resourceError = error instanceof DownloadResourceException ? error : undefined;
      record.status = 'queued';
      record.errorCode = resourceError?.errorCode ?? DOWNLOAD_ERROR_CODES.SERVER_BUSY;
      record.queueReason = (resourceError?.queueReason as DownloadQueueReason | undefined) ?? 'server_load';
      record.retryAfterMs = resourceError?.retryAfterMs;
      record.queuePosition = undefined;
      record.message = resourceError?.message ?? '服务器繁忙，任务仍在排队，请稍后重试';
      this.persistIfChanged(record);
      this.logger.debug(`下载任务预约失败（保持排队）: ${record.id} ${(error as Error).message}`);
    }
  }

  private isStructuralRejection(error: unknown): boolean {
    return error instanceof DownloadResourceException
      && error.errorCode === DOWNLOAD_ERROR_CODES.INSUFFICIENT_STORAGE;
  }

  /** 签发一次性票据（覆盖旧票据时先失效，避免多条有效票据指向同一预约） */
  private issueTicket(record: DownloadTaskRecord): void {
    if (record.ticket) this.ticketIndex.delete(record.ticket);
    const ticket = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    record.ticket = ticket;
    record.ticketExpiresAt = Date.now() + TASK_TICKET_TTL_MS;
    this.ticketIndex.set(ticket, record.id);
  }

  /** 释放任务持有的资源：作废票据、取消等待中的排队项、归还预约（幂等） */
  private releaseResources(record: DownloadTaskRecord, reason: string): void {
    if (record.ticket) {
      this.ticketIndex.delete(record.ticket);
      record.ticket = undefined;
      record.ticketExpiresAt = undefined;
    }
    record.abortController?.abort();
    if (record.reservation) {
      record.reservation.release();
      record.reservation = undefined;
      this.logger.debug(`下载任务释放预约: ${record.id}（${reason}）`);
    }
  }

  /** 依据缓存命中与只读资源探测推导任务状态 */
  private evaluate(record: DownloadTaskRecord): void {
    if (record.status === 'cancelled') return;
    record.updatedAt = Date.now();
    if (Date.now() > record.expiresAt) {
      this.releaseResources(record, '任务过期');
      record.status = 'expired';
      record.errorCode = 'DOWNLOAD_TASK_EXPIRED';
      record.message = '下载任务已过期，请重新发起下载';
      record.queueReason = undefined;
      record.queuePosition = undefined;
      record.retryAfterMs = undefined;
      return;
    }

    // 票据过期但客户端始终未发起正文请求：立即释放预约并把任务放回排队。
    // 否则单次 4GiB 预约会按 reservedPendingBytes 占用到任务保留期（默认 900s），
    // 多个被放弃的任务足以挤占物理预算，逼迫其他大文件降级直通。
    if (
      record.reservation
      && record.ticketExpiresAt !== undefined
      && Date.now() > record.ticketExpiresAt
    ) {
      this.releaseResources(record, '票据超时未使用');
      record.status = 'queued';
      record.message = '下载准备已超时，正在重新准备';
    }

    // 已持有预约或已交接给正文请求：资源确定可用，保持 streamable
    if (record.reservation || record.handedOff) {
      if (record.status !== 'streamable') {
        this.markStreamable(record, record.handedOff
          ? '资源已交给下载请求，正在传输'
          : '已为该任务预留磁盘空间，正在开始下载');
      }
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
      // 结构性不可行（完整暂存放不下）：真实下载会降级为有界直通，
      // 因此任务必须**立即变为可下载**；停在 queued 会让前端一直轮询到过期（历史缺陷）。
      record.mode = 'direct';
      this.markStreamable(record, '文件较大，将以直通方式下载（不占用本地缓存）');
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
    const deliverable = record.status === 'streamable' || record.status === 'queued';
    return {
      taskId: record.id,
      status: record.status,
      expectedSize: record.expectedSize,
      expiresAt: new Date(record.expiresAt).toISOString(),
      ...(deliverable ? { downloadUrl: this.deliverableUrl(record) } : {}),
      // 票据只在实际持有预约时下发：没有预约就没有可交接的资源
      ...(deliverable && record.ticket && record.ticketExpiresAt
        ? { ticket: record.ticket, ticketExpiresAt: new Date(record.ticketExpiresAt).toISOString() }
        : {}),
      ...(record.mode ? { mode: record.mode } : {}),
      ...(record.queueReason ? { queueReason: record.queueReason } : {}),
      ...(record.queuePosition !== undefined ? { queuePosition: record.queuePosition } : {}),
      ...(record.retryAfterMs !== undefined ? { retryAfterMs: record.retryAfterMs } : {}),
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      ...(record.message ? { message: record.message } : {}),
    };
  }

  /** 目标地址：资源就绪时追加一次性票据，正文请求凭它原子采用预约 */
  private deliverableUrl(record: DownloadTaskRecord): string {
    if (!record.ticket) return record.downloadUrl;
    const separator = record.downloadUrl.includes('?') ? '&' : '?';
    return `${record.downloadUrl}${separator}taskTicket=${record.ticket}`;
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

  /** 回收过期任务记录并归还其资源，避免内存/预约无界增长 */
  private sweep(): void {
    const now = Date.now();
    const retentionMs = this.fileCacheService.downloadTaskRetentionMs;
    let removed = 0;
    for (const [id, record] of this.tasks) {
      if (now > record.expiresAt && (record.reservation || record.ticket)) {
        this.releaseResources(record, '任务过期回收');
      }
      if (now > record.expiresAt + retentionMs) {
        this.tasks.delete(id);
        removed++;
      }
    }
    // 交接池中未被采用的预约同样需要回收（客户端拿到票据后没发起正文请求）
    this.fileCacheService.purgeExpiredDownloadReservations();
    if (removed > 0) {
      this.logger.debug(`回收过期下载任务 ${removed} 个（剩余 ${this.tasks.size}）`);
    }
  }
}
