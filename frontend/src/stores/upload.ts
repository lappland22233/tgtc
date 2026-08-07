import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api } from './auth';
import { useFileStore } from './files';
import { useChunkedUpload } from '../composables/useChunkedUpload';
import { getErrorMessage } from '../utils/error';
import { reportUploadError } from '../utils/telemetry';
import { MAX_ENTRY_RETRIES, getRetryDelay, abortableBackoff, classifyUploadError } from '../utils/upload-retry';

/**
 * 全局上传队列 store（模块级生命周期，组件卸载不销毁）。
 *
 * - 追加式入队：上传进行中可随时 enqueue 新文件，现有 worker 自然拾取。
 * - 文件级并发由 fileConcurrency 控制（默认 2，可调 1-4）；
 *   分片级在途请求总量另由 utils/upload-scheduler 令牌池全局限制（默认 4）。
 * - >5MB 走分片上传（分片并发 2），否则走 files.ts 的 uploadFileAsync。
 */

export type QueueStatus = 'pending' | 'processing' | 'success' | 'error' | 'cancelled';

export interface QueueEntry {
  uid: string;           // 唯一标识，防止同名文件覆盖
  /** 进入终态（success/error/cancelled）后置为 null 释放引用 */
  file: File | null;
  fileName: string;      // 冗余文件名，供 File 引用清理后仍可展示
  status: QueueStatus;
  errorReason?: string;
  progress: number;
  totalBytes: number;
  loadedBytes: number;
  speed: string;
  eta: string;
  checkpointTime: number;
  checkpointBytes: number;
  /** 数值速度 (B/s)，用于全局汇总 */
  speedBps: number;
  folderId: string | null;
  tagIds: string[];
  /** 文件夹上传：文件所属目录的相对路径（不含文件名）；平铺文件无此字段 */
  relativePath?: string;
  /** 文件夹上传批次 ID：同一次选择/拖拽产生的条目共享，便于后续按批操作 */
  batchId?: string;
  /** 覆盖上传：用户决策覆盖的既有文件 ID，后端据此替换原文件 */
  overwriteFileId?: string;
  /** 条目级自动重试已执行次数（仅 transient 错误触发，上限 MAX_ENTRY_RETRIES） */
  retryCount?: number;
}

/** 5MB 以上走分片上传，避免 CDN 超时截断 */
const CHUNK_THRESHOLD = 5 * 1024 * 1024;

/** 分片会话（含 uploadId / cancel），供 cancelOne 调用服务端 abort */
type ChunkedSession = ReturnType<typeof useChunkedUpload>;

function isTerminal(status: QueueStatus): boolean {
  return status === 'success' || status === 'error' || status === 'cancelled';
}

// ---- 重试熔断器（模块级，跨 store 实例共享）----
// 连续 6 个条目在首次尝试即遭 transient 失败则跳闸：网络大概率已整体不可用，
// 继续逐条退避重试只会徒增等待时间；跳闸后失败直接置 error，任一条目上传成功即清零恢复。
const BREAKER_TRIP_THRESHOLD = 6;
let transientFirstAttemptStreak = 0;
let retryBreakerTripped = false;

function recordTransientFirstAttemptFailure() {
  transientFirstAttemptStreak++;
  if (transientFirstAttemptStreak >= BREAKER_TRIP_THRESHOLD) {
    retryBreakerTripped = true;
  }
}

function resetRetryBreaker() {
  transientFirstAttemptStreak = 0;
  retryBreakerTripped = false;
}

/**
 * 生成唯一 ID。
 * crypto.randomUUID() 需要安全上下文且属 ES2022 运行时 API，
 * 构建 target 为 es2020 或 HTTP 部署时可能缺失，这里做逐级降级避免运行时崩溃。
 */
function genUid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // 设置 v4 UUID 的版本位与变体位
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '计算中...';
  if (bytesPerSec >= 1048576) return (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
  if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
  return bytesPerSec.toFixed(0) + ' B/s';
}

function formatETA(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return '计算中...';
  if (seconds >= 3600) return Math.ceil(seconds / 3600) + ' 小时';
  if (seconds >= 60) return Math.ceil(seconds / 60) + ' 分钟';
  return Math.ceil(seconds) + ' 秒';
}

export const useUploadStore = defineStore('upload', () => {
  // ---- 状态 ----
  const entries = ref<QueueEntry[]>([]);
  const isPumping = ref(false);
  /** 文件级并发（同时处理的文件数），可调 1-4 */
  const fileConcurrency = ref(2);

  // ---- 模块级（非响应式）内部状态 ----
  /** 每个条目独立的 AbortController */
  const controllers = new Map<string, AbortController>();
  /** 进行中的分片上传会话（uid → composable 实例，含 uploadId） */
  const chunkedSessions = new Map<string, ChunkedSession>();
  /** 本地文件预览 URL 缓存（迁移自 UploadModal 的 previewUrls） */
  const previewUrls = new Map<File, string>();
  let activeWorkers = 0;
  let speedTimer: ReturnType<typeof setInterval> | null = null;

  // ---- 汇总只读状态（供全局上传指示器使用） ----
  const activeCount = computed(() => entries.value.filter((e) => e.status === 'processing').length);
  const queuedCount = computed(() => entries.value.filter((e) => e.status === 'pending').length);
  /** 全部条目（含已完成）的总进度百分比 */
  const overallProgress = computed(() => {
    const total = entries.value.reduce((s, e) => s + e.totalBytes, 0);
    if (total <= 0) return 0;
    const loaded = entries.value.reduce((s, e) => s + e.loadedBytes, 0);
    return Math.min(100, Math.round((loaded / total) * 100));
  });
  const overallSpeed = computed(() => {
    const bps = entries.value.reduce((s, e) => s + (e.status === 'processing' ? e.speedBps : 0), 0);
    return bps > 0 ? formatSpeed(bps) : '-';
  });

  // ---- 速度/ETA 计算定时器（迁移自 UploadModal 的 updateSpeeds） ----
  function updateSpeeds() {
    const now = Date.now();
    for (const entry of entries.value) {
      if (entry.status !== 'processing') continue;
      // 尚未开始传输或 checkpointTime 未初始化 → 跳过
      if (entry.checkpointTime === 0) continue;
      const timeDiff = (now - entry.checkpointTime) / 1000;
      if (timeDiff <= 0) continue;
      const bytesDiff = entry.loadedBytes - entry.checkpointBytes;
      const speed = Math.max(0, bytesDiff / timeDiff);
      entry.speedBps = speed;
      entry.speed = formatSpeed(speed);
      const remaining = entry.totalBytes - entry.loadedBytes;
      entry.eta = formatETA(speed > 0 ? remaining / speed : 0);
      entry.checkpointTime = now;
      entry.checkpointBytes = entry.loadedBytes;
    }
  }

  function startSpeedTimer() {
    stopSpeedTimer();
    speedTimer = setInterval(updateSpeeds, 3000);
  }

  function stopSpeedTimer() {
    if (speedTimer) {
      clearInterval(speedTimer);
      speedTimer = null;
    }
  }

  // ---- 预览 URL（迁移自 UploadModal 的 getPreviewUrl / revoke 逻辑） ----
  function getPreviewUrl(file: File): string {
    if (!previewUrls.has(file)) {
      previewUrls.set(file, URL.createObjectURL(file));
    }
    return previewUrls.get(file)!;
  }

  /** 条目进入终态后清理 File 引用与 ObjectURL，防止内存泄漏 */
  function finalizeEntry(entry: QueueEntry) {
    if (!isTerminal(entry.status)) return;
    if (entry.file) {
      const url = previewUrls.get(entry.file);
      if (url) {
        URL.revokeObjectURL(url);
        previewUrls.delete(entry.file);
      }
      entry.file = null;
    }
  }

  // ---- 单文件处理 ----
  /** 上传成功后关联标签（迁移自 UploadModal 原批量完成后关联逻辑，改为单文件完成即关联） */
  async function attachTags(entry: QueueEntry, fileId: string) {
    if (entry.tagIds.length === 0) return;
    await api.put(`/files/${fileId}/tags`, { tagIds: entry.tagIds }).catch(() => {});
  }

  async function uploadChunked(entry: QueueEntry, file: File, controller: AbortController) {
    // 每个文件使用独立实例，避免并发文件共享 uploadId、进度和速度检查点。
    // useChunkedUpload 内部仅使用 ref（无 onMounted 等生命周期依赖），在 store 中调用安全。
    // 分片并发降为 2：全局令牌池（默认 4）已统一限制在途上传请求总数。
    const chunked = useChunkedUpload(2);
    chunkedSessions.set(entry.uid, chunked);
    const result = await chunked.uploadFile(
      file,
      (p) => {
        entry.progress = p.totalChunks > 0 ? Math.round((p.uploadedChunks / p.totalChunks) * 100) : 0;
        entry.loadedBytes = p.loadedBytes;
        entry.speed = p.speed;
        entry.eta = p.eta;
        if (entry.checkpointTime === 0) {
          entry.checkpointTime = Date.now();
        }
      },
      controller.signal,
      undefined,
      entry.folderId,
      entry.overwriteFileId,
    );
    entry.status = 'success';
    await attachTags(entry, result.id);
  }

  async function uploadSmall(entry: QueueEntry, file: File, controller: AbortController) {
    const fileStore = useFileStore();
    try {
      // 异步上传：文件传输完成后立即断开请求连接（避免 Cloudflare 代理超时），
      // 后端在后台处理 Telegram 上传，前端轮询获取状态
      const result = await fileStore.uploadFileAsync(
        file,
        (loaded, total) => {
          // 文件传输进度（浏览器 → 服务器）
          entry.progress = total > 0 ? Math.round((loaded / total) * 100) : 0;
          entry.loadedBytes = loaded;
          // 首次收到进度数据时记录传输开始时间（排除排队等待时间）
          if (entry.checkpointTime === 0 && loaded > 0) {
            entry.checkpointTime = Date.now();
          }
        },
        (status) => {
          // 后端处理状态更新
          if (status === 'uploading') {
            entry.status = 'processing';
          }
        },
        controller.signal,
        entry.folderId,
        entry.overwriteFileId,
      );
      entry.status = 'success';
      await attachTags(entry, result.id);
    } catch (error) {
      const axiosError = error as { response?: { status?: number }; code?: string };
      if (!controller.signal.aborted && axiosError.code !== 'ERR_CANCELED') {
        reportUploadError({
          stage: 'async_upload',
          message: getErrorMessage(error),
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          status: axiosError.response?.status,
        });
      }
      throw error;
    }
  }

  async function processEntry(entry: QueueEntry) {
    const controller = new AbortController();
    controllers.set(entry.uid, controller);
    const file = entry.file;
    if (!file) {
      entry.status = 'error';
      entry.errorReason = '文件引用丢失';
      return;
    }
    try {
      // attempt 循环：transient 错误在同一条目内自动重试（复用同一 controller），
      // 其余错误直接进入终态；退避等待期间用户取消立即退出。
      for (;;) {
        try {
          if (file.size > CHUNK_THRESHOLD) {
            await uploadChunked(entry, file, controller);
          } else {
            await uploadSmall(entry, file, controller);
          }
          // 上传成功：熔断器计数清零（网络恢复信号）
          resetRetryBreaker();
          return;
        } catch (error: unknown) {
          if (controller.signal.aborted) {
            entry.status = 'cancelled';
            return;
          }
          const classification = classifyUploadError(error);
          const currentRetries = entry.retryCount ?? 0;
          if (classification.retryable && currentRetries < MAX_ENTRY_RETRIES && !retryBreakerTripped) {
            entry.retryCount = currentRetries + 1;
            // 重置进度/速度检查点，避免重试退避时间被计入速率统计
            entry.progress = 0;
            entry.loadedBytes = 0;
            entry.checkpointTime = 0;
            entry.checkpointBytes = 0;
            entry.speed = '-';
            entry.eta = '-';
            entry.errorReason = undefined;
            try {
              await abortableBackoff(getRetryDelay(entry.retryCount), controller.signal);
            } catch {
              // 退避期间被取消：置 cancelled 退出
              entry.status = 'cancelled';
              return;
            }
            continue;
          }
          if (classification.retryable && retryBreakerTripped) {
            // 熔断已跳闸：不再重试，明确提示用户检查网络
            recordTransientFirstAttemptFailure();
            entry.status = 'error';
            entry.errorReason = '网络异常，自动重试已暂停，请检查网络后重新上传';
            return;
          }
          if (classification.retryable) {
            // 重试次数耗尽：首次尝试即失败则累计熔断计数
            if (currentRetries === 0) {
              recordTransientFirstAttemptFailure();
            }
          }
          entry.status = 'error';
          entry.errorReason = getErrorMessage(error);
          return;
        }
      }
    } finally {
      controllers.delete(entry.uid);
      chunkedSessions.delete(entry.uid);
      finalizeEntry(entry);
    }
  }

  // ---- worker 循环 ----
  /**
   * worker 每轮从 entries 中实时查找下一个 pending 条目消费（非启动时快照），
   * 因此运行时新入队的条目会被现有 worker 自然拾取；
   * 队列无 pending 且 worker 全部退出时置 isPumping=false。
   */
  async function worker() {
    try {
      for (;;) {
        const entry = entries.value.find((e) => e.status === 'pending');
        if (!entry) return;
        entry.status = 'processing';
        await processEntry(entry);
      }
    } finally {
      activeWorkers--;
      // 收尾期间可能有新文件入队：若仍有 pending 则补充 worker
      if (entries.value.some((e) => e.status === 'pending')) {
        ensurePump();
      } else if (activeWorkers === 0) {
        isPumping.value = false;
        updateSpeeds();
        stopSpeedTimer();
      }
    }
  }

  /** 按需补足 worker 至 min(fileConcurrency, 待处理数)，幂等可重复调用 */
  function ensurePump() {
    const pendingCount = entries.value.filter((e) => e.status === 'pending').length;
    if (pendingCount === 0) return;
    isPumping.value = true;
    startSpeedTimer();
    const spawn = Math.min(fileConcurrency.value, pendingCount) - activeWorkers;
    for (let i = 0; i < spawn; i++) {
      activeWorkers++;
      worker().catch((err) => {
        console.error('[上传队列] worker 异常退出:', err);
      });
    }
  }

  // ---- 对外 API ----
  /**
   * 追加式入队：按同一 File 引用去重，上传进行中可随时调用。
   * 入队后立即 ensurePump()，新条目由现有 worker 拾取或触发补充 worker。
   */
  function enqueue(files: File[], folderId: string | null, tagIds: string[]) {
    const newEntries: QueueEntry[] = [];
    for (const f of files) {
      if (!f) continue;
      // 同一 File 引用已在队列中（任意状态）则跳过
      if (entries.value.some((e) => e.file === f)) continue;
      newEntries.push({
        uid: genUid(),
        file: f,
        fileName: f.name,
        status: 'pending',
        errorReason: undefined,
        progress: 0,
        totalBytes: f.size,
        loadedBytes: 0,
        speed: '-',
        eta: '-',
        checkpointTime: 0,  // 延迟到首次进度回调时记录，排除排队等待时间
        checkpointBytes: 0,
        speedBps: 0,
        folderId,
        tagIds: [...tagIds],
        retryCount: 0,
      });
    }
    if (newEntries.length === 0) return;
    entries.value.push(...newEntries);
    ensurePump();
  }

  /**
   * 文件夹上传入队：每条 item 已携带预创建/复用后的最终 folderId。
   * 与 enqueue 相同的 File 引用去重策略；入队后立即 ensurePump()，
   * worker / 取消 / 终态清理逻辑完全复用，零改动。
   */
  function enqueueFolderFiles(
    items: Array<{ file: File; folderId: string | null; relativePath?: string; overwriteFileId?: string }>,
    tagIds: string[],
    batchId?: string,
  ) {
    const newEntries: QueueEntry[] = [];
    // 同批内按 (folderId, fileName) 去重，防止同批双写（保留第一个）
    const seenInBatch = new Set<string>();
    for (const item of items) {
      if (!item.file) continue;
      const batchKey = `${item.folderId ?? 'root'}:${item.file.name}`;
      if (seenInBatch.has(batchKey)) continue;
      seenInBatch.add(batchKey);
      // 同一 File 引用已在队列中（任意状态）则跳过
      if (entries.value.some((e) => e.file === item.file)) continue;
      newEntries.push({
        uid: genUid(),
        file: item.file,
        fileName: item.file.name,
        status: 'pending',
        errorReason: undefined,
        progress: 0,
        totalBytes: item.file.size,
        loadedBytes: 0,
        speed: '-',
        eta: '-',
        checkpointTime: 0,
        checkpointBytes: 0,
        speedBps: 0,
        folderId: item.folderId,
        tagIds: [...tagIds],
        relativePath: item.relativePath || undefined,
        batchId,
        overwriteFileId: item.overwriteFileId,
        retryCount: 0,
      });
    }
    if (newEntries.length === 0) return;
    entries.value.push(...newEntries);
    ensurePump();
  }

  /**
   * 取消单个条目：abort 对应 controller；若该文件已建立分片会话（有 uploadId）
   * 则同时 POST /files/chunk/:uploadId/abort 通知服务端清理。
   */
  function cancelOne(uid: string) {
    const entry = entries.value.find((e) => e.uid === uid);
    if (!entry || isTerminal(entry.status)) return;
    if (entry.status === 'pending') {
      // 尚未开始：直接置为已取消，worker 拾取时会跳过
      entry.status = 'cancelled';
      finalizeEntry(entry);
      return;
    }
    controllers.get(uid)?.abort();
    const uploadId = chunkedSessions.get(uid)?.uploadId.value;
    if (uploadId) {
      api.post(`/files/chunk/${uploadId}/abort`).catch(() => {});
    }
  }

  /** 取消全部进行中/排队中的条目 */
  function cancelAll() {
    for (const entry of [...entries.value]) {
      if (!isTerminal(entry.status)) cancelOne(entry.uid);
    }
  }

  /** 清理所有终态条目（success/error/cancelled） */
  function clearFinished() {
    entries.value = entries.value.filter((e) => !isTerminal(e.status));
  }

  /** 设置文件级并发（clamp 1-4）；运行时上调会立即补充 worker */
  function setFileConcurrency(n: number) {
    fileConcurrency.value = Math.min(4, Math.max(1, Math.floor(n)));
    if (entries.value.some((e) => e.status === 'pending')) {
      ensurePump();
    }
  }

  return {
    // 状态
    entries,
    isPumping,
    fileConcurrency,
    // 汇总
    activeCount,
    queuedCount,
    overallProgress,
    overallSpeed,
    // 操作
    enqueue,
    enqueueFolderFiles,
    cancelOne,
    cancelAll,
    clearFinished,
    setFileConcurrency,
    getPreviewUrl,
  };
});
