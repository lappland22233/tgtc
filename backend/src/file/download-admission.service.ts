import { Injectable, Logger } from '@nestjs/common';

/**
 * 下载磁盘准入服务（小盘无缓存持续下载修复）
 *
 * 职责：
 * - 下载会话开始写盘（spool/.tmp）与回源前，按物理卷剩余空间做原子预算准入；
 * - 空间不足时进入有界 FIFO 等待队列，空间释放（会话完成/清理）后事件唤醒；
 * - 区分"已预留尚未写入"的预约量与实际写入量，避免并发请求重复使用同一份空闲空间。
 *
 * 设计边界：
 * - 单后端进程内的协调；多进程部署时各进程独立计数（与既有上传预算一致），
 *   启用严格保证前须核实部署模式。
 * - 不改变 Bot API 侧行为；TDLib 本地副本由 Bot API 工作目录自行管理，
 *   本服务只保证后端缓存卷上"最低安全余量 + 本会话剩余峰值增量"可容纳后再放行。
 * - 物理剩余量（statfs）已包含已落盘占用；预约量只统计"尚未写入"的增长，
 *   二者相减后仍容纳新会话剩余增量才准入，不重复扣减。
 */

/** 准入失败原因（供上层映射 HTTP 状态与提示） */
export enum AdmissionRejection {
  /** 系统正在关闭，不再接纳新会话 */
  SHUTTING_DOWN = 'SHUTTING_DOWN',
  /** 单会话剩余峰值超过"安全余量 + 空闲 - 其他预约"，等待也无法满足 */
  CAPACITY_EXCEEDED = 'CAPACITY_EXCEEDED',
  /** 空间探测失败（statfs 异常），暂时不可用 */
  PROBE_UNAVAILABLE = 'PROBE_UNAVAILABLE',
}

export interface AdmissionTicket {
  /** 取消等待（最后一个等待者离开后移除任务） */
  cancel: () => void;
  /** 等待 Promise：resolve 后调用方获得许可；reject 为拒绝/超时/取消 */
  done: Promise<void>;
}

export interface AdmissionOptions {
  /** 可选的等待期限（毫秒），超时后以超时错误拒绝 */
  waitTimeoutMs?: number;
  /** 等待期间物理空闲仍不足以容纳单会话时，立即按容量超限拒绝 */
  rejectIfUnsatisfiable?: boolean;
}

interface WaitingEntry {
  bytes: number;
  resolve: () => void;
  reject: (error: Error) => void;
  enqueueAt: number;
  timeoutTimer?: NodeJS.Timeout;
}

export const DOWNLOAD_ADMISSION_LIMITS = {
  /** 全局最多排队等待项（有界队列） */
  MAX_WAITING: 128,
  /** 单次等待默认上限（30 分钟），超时返回明确可重试状态 */
  DEFAULT_WAIT_TIMEOUT_MS: 30 * 60 * 1000,
  /** 事件唤醒后兜底复查物理余量的间隔（毫秒，有界退避，不忙轮询） */
  POLL_INTERVAL_MS: 30_000,
} as const;

@Injectable()
export class DownloadAdmissionService {
  private readonly logger = new Logger(DownloadAdmissionService.name);
  /** statfs 探测目标目录（缓存目录），由服务持有方在 onModuleInit 前配置 */
  private probeDir: string | null = null;
  /** 每卷"已预留、尚未写入"的字节（预约量） */
  private reservedPendingBytes = 0;
  /** 当前物理空闲字节（最近一次探测结果；-1 表示探测失败） */
  private lastFreeBytes = -1;
  private readonly waiting: WaitingEntry[] = [];
  private pollTimer: NodeJS.Timeout | null = null;

  /** 配置探测目录（缓存所在卷根路径） */
  setProbeDir(dir: string): void {
    this.probeDir = dir;
  }

  /** 当前等待队列长度（监控/测试） */
  get waitingCount(): number {
    return this.waiting.length;
  }

  /** 当前未消费预约量（监控/测试） */
  get pendingReservedBytes(): number {
    return this.reservedPendingBytes;
  }

  /**
   * 探测物理可用空间（bavail，无特权可用块）。
   * 失败返回 -1（保守按不可用处理）。
   */
  private probeFreeBytes(): number {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { statfsSync } = require('fs');
      const dir = this.probeDir ?? process.cwd();
      const stats = statfsSync(dir);
      const availBlocks = stats.bavail > 0 ? stats.bavail : 0;
      return stats.bsize * availBlocks;
    } catch {
      return -1;
    }
  }

  /**
   * 判断当前空间是否允许以 bytes 增量开始写盘。
   * 规则：空闲 - 最低安全余量 - 其他会话未消费预约 >= 本次增量。
   */
  private canAdmit(bytes: number, minFreeBytes: number, freeBytes: number): boolean {
    return freeBytes - minFreeBytes - this.reservedPendingBytes >= bytes;
  }

  /** 空间释放后唤醒队列头部可满足的等待项 */
  private pump(minFreeBytes: number): void {
    while (this.waiting.length > 0) {
      const freeBytes = this.lastFreeBytes >= 0 ? this.probeFreeBytes() : this.probeFreeBytes();
      this.lastFreeBytes = freeBytes;
      if (freeBytes < 0) return; // 探测失败：暂停唤醒，等待兜底轮询
      const head = this.waiting[0];
      if (this.canAdmit(head.bytes, minFreeBytes, freeBytes)) {
        this.waiting.shift();
        this.reservedPendingBytes += head.bytes;
        if (head.timeoutTimer) clearTimeout(head.timeoutTimer);
        head.resolve();
      } else {
        // FIFO：队头无法满足时不跳过，避免饥饿（队头若永久无法满足由超时/容量检查移除）
        return;
      }
    }
    if (this.waiting.length === 0 && this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** 兜底轮询：事件遗漏或外部程序释放空间时周期复查 */
  private ensurePollTimer(minFreeBytes: number): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (this.waiting.length === 0) {
        clearInterval(this.pollTimer!);
        this.pollTimer = null;
        return;
      }
      this.pump(minFreeBytes);
    }, DOWNLOAD_ADMISSION_LIMITS.POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  /**
   * 请求写盘准入。
   * - 立即可满足：同步登记预约并 resolve；
   * - 空间不足：进入 FIFO 等待（有界、可取消、有超时）；
   * - 单会话剩余峰值永远无法满足：立即按容量超限拒绝，不无限排队。
   */
  async admit(bytes: number, minFreeBytes: number, options?: AdmissionOptions): Promise<AdmissionTicket> {
    const waitTimeoutMs = options?.waitTimeoutMs ?? DOWNLOAD_ADMISSION_LIMITS.DEFAULT_WAIT_TIMEOUT_MS;
    const rejectIfUnsatisfiable = options?.rejectIfUnsatisfiable ?? true;

    let freeBytes = this.probeFreeBytes();
    if (freeBytes < 0) {
      this.lastFreeBytes = -1;
      throw this.rejection(AdmissionRejection.PROBE_UNAVAILABLE, '磁盘空间探测失败，暂时无法开始下载');
    }
    this.lastFreeBytes = freeBytes;

    if (this.canAdmit(bytes, minFreeBytes, freeBytes)) {
      this.reservedPendingBytes += bytes;
      return { done: Promise.resolve(), cancel: () => {} };
    }

    if (rejectIfUnsatisfiable && freeBytes - minFreeBytes - this.reservedPendingBytes < bytes) {
      // 当前空闲扣去安全余量与既有预约后仍容纳不了本会话：
      // 若历史上从未有更大空闲（本轮峰值不可达），等待无意义，立即拒绝。
      // 简化判定：本轮探测空闲 - 余量 - 预约 < bytes 且预约方都在增长，等待期间只会更紧。
      // 但外部程序可能释放空间，因此仅当"空闲 - 余量"本身容纳不了单会话时才硬拒绝。
      if (freeBytes - minFreeBytes < bytes) {
        throw this.rejection(
          AdmissionRejection.CAPACITY_EXCEEDED,
          `文件大小超过当前磁盘可安全承载的空间（需要 ${bytes} 字节，空闲 ${freeBytes} 字节）`,
        );
      }
    }

    if (this.waiting.length >= DOWNLOAD_ADMISSION_LIMITS.MAX_WAITING) {
      throw this.rejection(AdmissionRejection.CAPACITY_EXCEEDED, '下载排队已满，请稍后重试');
    }

    return new Promise<AdmissionTicket>((ticketResolve, ticketReject) => {
      const entry: WaitingEntry = {
        bytes,
        resolve: () => {
          this.logger.debug(`下载准入放行: ${bytes} 字节（等待队列剩余 ${this.waiting.length}）`);
          ticketResolve({ done: Promise.resolve(), cancel: () => {} });
        },
        reject: (error: Error) => ticketReject(error),
        enqueueAt: Date.now(),
      };
      const timer = setTimeout(() => {
        const idx = this.waiting.indexOf(entry);
        if (idx >= 0) this.waiting.splice(idx, 1);
        entry.reject(new Error('下载等待空间超时，请稍后重试'));
      }, waitTimeoutMs);
      timer.unref?.();
      entry.timeoutTimer = timer;
      this.waiting.push(entry);
      this.ensurePollTimer(minFreeBytes);
    });
  }

  /**
   * 会话完成/中止/清理后调用：先按实际写入扣减预约，再唤醒等待队列。
   * 调用方必须保证 bytes 与 admit 时登记一致（或提供实际写入量差值）。
   */
  release(bytes: number, minFreeBytes: number): void {
    this.reservedPendingBytes = Math.max(0, this.reservedPendingBytes - bytes);
    this.pump(minFreeBytes);
  }

  /** 会话写入过程中释放部分额度（如提前中止，按未写入部分归还） */
  releasePartial(writtenBytes: number, admittedBytes: number, minFreeBytes: number): void {
    const unmet = Math.max(0, admittedBytes - writtenBytes);
    this.release(unmet, minFreeBytes);
  }

  /** 关闭：拒绝所有等待项并停止轮询 */
  shutdown(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const entry of this.waiting.splice(0)) {
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
      entry.reject(new Error('系统正在关闭，下载等待已取消'));
    }
  }

  private rejection(reason: AdmissionRejection, message: string): Error {
    const error = new Error(message) as Error & { admissionReason?: AdmissionRejection };
    error.admissionReason = reason;
    return error;
  }
}
