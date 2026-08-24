import { defineStore } from 'pinia';
import { computed, markRaw, ref, shallowReactive, shallowRef, triggerRef, watch } from 'vue';
import { api } from './auth';
import { useFileStore } from './files';
import { useChunkedUpload } from '../composables/useChunkedUpload';
import { isPageVisible } from '../composables/usePageVisibility';
import { getErrorMessage } from '../utils/error';
import { uploadScheduler } from '../utils/upload-scheduler';
import { MAX_ENTRY_RETRIES, getRetryDelay, abortableBackoff, classifyUploadError } from '../utils/upload-retry';

export type QueueStatus = 'pending' | 'processing' | 'success' | 'error' | 'cancelled';

export interface QueueEntry {
  uid: string;
  file: File | null;
  fileName: string;
  mimeType: string;
  status: QueueStatus;
  errorReason?: string;
  progress: number;
  totalBytes: number;
  loadedBytes: number;
  speed: string;
  eta: string;
  checkpointTime: number;
  checkpointBytes: number;
  speedBps: number;
  folderId: string | null;
  tagIds: string[];
  relativePath?: string;
  batchId?: string;
  overwriteFileId?: string;
  retryCount?: number;
}

interface ProgressSnapshot {
  loadedBytes: number;
  progress: number;
  speed?: string;
  eta?: string;
}

const CHUNK_THRESHOLD = 5 * 1024 * 1024;
const FOREGROUND_PROGRESS_INTERVAL = 150;
const BACKGROUND_PROGRESS_INTERVAL = 1500;
type ChunkedSession = ReturnType<typeof useChunkedUpload>;

function isTerminal(status: QueueStatus): boolean {
  return status === 'success' || status === 'error' || status === 'cancelled';
}

const BREAKER_TRIP_THRESHOLD = 6;
let transientFirstAttemptStreak = 0;
let retryBreakerTripped = false;

function recordTransientFirstAttemptFailure() {
  transientFirstAttemptStreak++;
  if (transientFirstAttemptStreak >= BREAKER_TRIP_THRESHOLD) retryBreakerTripped = true;
}

function resetRetryBreaker() {
  transientFirstAttemptStreak = 0;
  retryBreakerTripped = false;
}

// G11-27：断网恢复后自动重置熔断器，使队列可继续重试 / 重新上传。
// 熔断在连续瞬时失败 ≥ BREAKER_TRIP_THRESHOLD 次后触发并暂停自动重试；
// 网络恢复（online）视为故障已消除，重置计数以允许后续条目正常重试。
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (retryBreakerTripped) {
      console.info('[上传队列] 网络已恢复，重置重试熔断器');
      resetRetryBreaker();
    }
  });
}

function genUid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '计算中...';
  if (bytesPerSec >= 1048576) return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSec.toFixed(0)} B/s`;
}

function formatETA(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return '计算中...';
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)} 小时`;
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${Math.ceil(seconds)} 秒`;
}

export const useUploadStore = defineStore('upload', () => {
  const entries = shallowRef<QueueEntry[]>([]);
  const isPumping = ref(false);
  const fileConcurrency = ref(2);
  const activeCount = ref(0);
  const queuedCount = ref(0);
  const successCount = ref(0);
  const errorCount = ref(0);
  const cancelledCount = ref(0);
  const totalBytes = ref(0);
  const loadedBytes = ref(0);

  const entryByUid = new Map<string, QueueEntry>();
  const knownFiles = new WeakSet<File>();
  const controllers = new Map<string, AbortController>();
  const chunkedSessions = new Map<string, ChunkedSession>();
  const activeEntries = new Set<QueueEntry>();
  const pendingProgress = new Map<string, ProgressSnapshot>();
  const pendingQueue: QueueEntry[] = [];
  let pendingCursor = 0;
  let activeWorkers = 0;
  let speedTimer: ReturnType<typeof setInterval> | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let foregroundChunkConcurrency = uploadScheduler.getConcurrency();

  const overallProgress = computed(() => totalBytes.value <= 0
    ? 0
    : Math.min(100, Math.round((loadedBytes.value / totalBytes.value) * 100)));
  const overallSpeed = computed(() => {
    let bps = 0;
    for (const entry of activeEntries) bps += entry.speedBps;
    return bps > 0 ? formatSpeed(bps) : '-';
  });
  const finishedCount = computed(() => successCount.value + errorCount.value + cancelledCount.value);

  function setLoaded(entry: QueueEntry, nextLoaded: number) {
    const normalized = Math.min(entry.totalBytes, Math.max(0, nextLoaded));
    loadedBytes.value += normalized - entry.loadedBytes;
    entry.loadedBytes = normalized;
  }

  function flushProgress() {
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    for (const [uid, snapshot] of pendingProgress) {
      const entry = entryByUid.get(uid);
      if (!entry || isTerminal(entry.status)) continue;
      setLoaded(entry, snapshot.loadedBytes);
      entry.progress = snapshot.progress;
      if (snapshot.speed !== undefined) entry.speed = snapshot.speed;
      if (snapshot.eta !== undefined) entry.eta = snapshot.eta;
      if (entry.checkpointTime === 0 && snapshot.loadedBytes > 0) entry.checkpointTime = Date.now();
    }
    pendingProgress.clear();
  }

  function scheduleProgress(entry: QueueEntry, snapshot: ProgressSnapshot) {
    pendingProgress.set(entry.uid, snapshot);
    if (progressTimer) return;
    progressTimer = setTimeout(
      flushProgress,
      isPageVisible.value ? FOREGROUND_PROGRESS_INTERVAL : BACKGROUND_PROGRESS_INTERVAL,
    );
  }

  function changeStatus(entry: QueueEntry, next: QueueStatus) {
    const previous = entry.status;
    if (previous === next) return;
    if (previous === 'pending') queuedCount.value--;
    if (previous === 'processing') {
      activeCount.value--;
      activeEntries.delete(entry);
    }
    if (previous === 'success') successCount.value--;
    if (previous === 'error') errorCount.value--;
    if (previous === 'cancelled') cancelledCount.value--;

    entry.status = next;
    if (next === 'pending') queuedCount.value++;
    if (next === 'processing') {
      activeCount.value++;
      activeEntries.add(entry);
    }
    if (next === 'success') successCount.value++;
    if (next === 'error') errorCount.value++;
    if (next === 'cancelled') cancelledCount.value++;
  }

  function updateSpeeds() {
    const now = Date.now();
    for (const entry of activeEntries) {
      if (entry.checkpointTime === 0) continue;
      const timeDiff = (now - entry.checkpointTime) / 1000;
      if (timeDiff <= 0) continue;
      const bytesDiff = entry.loadedBytes - entry.checkpointBytes;
      const speed = Math.max(0, bytesDiff / timeDiff);
      entry.speedBps = speed;
      entry.speed = formatSpeed(speed);
      entry.eta = formatETA(speed > 0 ? (entry.totalBytes - entry.loadedBytes) / speed : 0);
      entry.checkpointTime = now;
      entry.checkpointBytes = entry.loadedBytes;
    }
  }

  function stopSpeedTimer() {
    if (!speedTimer) return;
    clearInterval(speedTimer);
    speedTimer = null;
  }

  function startSpeedTimer() {
    if (!isPageVisible.value || speedTimer) return;
    speedTimer = setInterval(updateSpeeds, 3000);
  }

  watch(isPageVisible, (visible) => {
    flushProgress();
    if (visible) {
      uploadScheduler.setConcurrency(foregroundChunkConcurrency);
      if (activeCount.value > 0) startSpeedTimer();
    } else {
      foregroundChunkConcurrency = uploadScheduler.getConcurrency();
      uploadScheduler.setConcurrency(Math.min(2, foregroundChunkConcurrency));
      stopSpeedTimer();
    }
  });

  function finalizeEntry(entry: QueueEntry) {
    if (!isTerminal(entry.status)) return;
    pendingProgress.delete(entry.uid);
    // G10-06：终态条目从 knownFiles 移除其 File 引用，使同一 File 可被重新拖拽上传。
    // （WeakSet 不支持遍历删除，故在置空 file 前显式 delete。）
    if (entry.file) knownFiles.delete(entry.file);
    entry.file = null;
    entry.tagIds = [];
  }

  async function attachTags(entry: QueueEntry, fileId: string) {
    if (entry.tagIds.length === 0) return;
    await api.put(`/files/${fileId}/tags`, { tagIds: entry.tagIds }).catch(() => {});
  }

  async function uploadChunked(entry: QueueEntry, file: File, controller: AbortController) {
    const chunked = useChunkedUpload(2);
    chunkedSessions.set(entry.uid, chunked);
    const result = await chunked.uploadFile(
      file,
      (p) => scheduleProgress(entry, {
        progress: p.totalChunks > 0 ? Math.round((p.uploadedChunks / p.totalChunks) * 100) : 0,
        loadedBytes: p.loadedBytes,
        speed: p.speed,
        eta: p.eta,
      }),
      controller.signal,
      undefined,
      entry.folderId,
      entry.overwriteFileId,
    );
    flushProgress();
    setLoaded(entry, entry.totalBytes);
    entry.progress = 100;
    changeStatus(entry, 'success');
    await attachTags(entry, result.id);
  }

  async function uploadSmall(entry: QueueEntry, file: File, controller: AbortController) {
    const fileStore = useFileStore();
    try {
      const result = await fileStore.uploadFileAsync(
        file,
        (loaded, total) => scheduleProgress(entry, {
          progress: total > 0 ? Math.round((loaded / total) * 100) : 0,
          loadedBytes: loaded,
        }),
        () => {},
        controller.signal,
        entry.folderId,
        entry.overwriteFileId,
      );
      flushProgress();
      setLoaded(entry, entry.totalBytes);
      entry.progress = 100;
      changeStatus(entry, 'success');
      await attachTags(entry, result.id);
    } catch (error) {
      throw error;
    }
  }

  async function processEntry(entry: QueueEntry) {
    const controller = new AbortController();
    controllers.set(entry.uid, controller);
    const file = entry.file;
    if (!file) {
      changeStatus(entry, 'error');
      entry.errorReason = '文件引用丢失';
      return;
    }
    try {
      for (;;) {
        try {
          if (file.size > CHUNK_THRESHOLD) await uploadChunked(entry, file, controller);
          else await uploadSmall(entry, file, controller);
          resetRetryBreaker();
          return;
        } catch (error: unknown) {
          if (controller.signal.aborted) {
            changeStatus(entry, 'cancelled');
            return;
          }
          const classification = classifyUploadError(error);
          const currentRetries = entry.retryCount ?? 0;
          if (classification.retryable && currentRetries < MAX_ENTRY_RETRIES && !retryBreakerTripped) {
            entry.retryCount = currentRetries + 1;
            pendingProgress.delete(entry.uid);
            setLoaded(entry, 0);
            entry.progress = 0;
            entry.checkpointTime = 0;
            entry.checkpointBytes = 0;
            entry.speed = '-';
            entry.eta = '-';
            entry.errorReason = undefined;
            try {
              await abortableBackoff(getRetryDelay(entry.retryCount), controller.signal);
            } catch {
              changeStatus(entry, 'cancelled');
              return;
            }
            continue;
          }
          if (classification.retryable && retryBreakerTripped) {
            recordTransientFirstAttemptFailure();
            changeStatus(entry, 'error');
            entry.errorReason = '网络异常，自动重试已暂停，请检查网络后重新上传';
            return;
          }
          if (classification.retryable && currentRetries === 0) recordTransientFirstAttemptFailure();
          changeStatus(entry, 'error');
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

  function takePending(): QueueEntry | undefined {
    while (pendingCursor < pendingQueue.length) {
      const entry = pendingQueue[pendingCursor++];
      if (entry.status === 'pending') return entry;
    }
    if (pendingCursor >= pendingQueue.length) {
      pendingQueue.length = 0;
      pendingCursor = 0;
    }
    return undefined;
  }

  async function worker() {
    try {
      for (;;) {
        const entry = takePending();
        if (!entry) return;
        changeStatus(entry, 'processing');
        await processEntry(entry);
      }
    } finally {
      activeWorkers--;
      if (queuedCount.value > 0) ensurePump();
      else if (activeWorkers === 0) {
        isPumping.value = false;
        flushProgress();
        updateSpeeds();
        stopSpeedTimer();
      }
    }
  }

  function ensurePump() {
    if (queuedCount.value === 0) return;
    isPumping.value = true;
    startSpeedTimer();
    const spawn = Math.min(fileConcurrency.value, queuedCount.value) - activeWorkers;
    for (let i = 0; i < spawn; i++) {
      activeWorkers++;
      worker().catch((err) => console.error('[上传队列] worker 异常退出:', err));
    }
  }

  function createEntry(file: File, folderId: string | null, tagIds: string[]): QueueEntry {
    return shallowReactive({
      uid: genUid(),
      file: markRaw(file),
      fileName: file.name,
      mimeType: file.type,
      status: 'pending' as QueueStatus,
      errorReason: undefined,
      progress: 0,
      totalBytes: file.size,
      loadedBytes: 0,
      speed: '-',
      eta: '-',
      checkpointTime: 0,
      checkpointBytes: 0,
      speedBps: 0,
      folderId,
      tagIds: [...tagIds],
      retryCount: 0,
    });
  }

  /**
   * 判断同一 File 引用是否已有“非终态”条目（进行中 / 等待 / 处理中）。
   * 终态（成功/失败/取消）条目允许同一 File 重新拖拽上传（G11-26）。
   */
  function hasActiveFile(file: File): boolean {
    for (const e of entries.value) {
      if (e.file === file && !isTerminal(e.status)) return true;
    }
    return false;
  }

  function appendEntries(newEntries: QueueEntry[]) {
    if (newEntries.length === 0) return;
    for (const entry of newEntries) {
      entryByUid.set(entry.uid, entry);
      if (entry.file) knownFiles.add(entry.file);
      pendingQueue.push(entry);
      queuedCount.value++;
      totalBytes.value += entry.totalBytes;
    }
    entries.value.push(...newEntries);
    triggerRef(entries);
    ensurePump();
  }

  function enqueue(files: File[], folderId: string | null, tagIds: string[]) {
    const newEntries: QueueEntry[] = [];
    for (const file of files) {
      if (!file || hasActiveFile(file)) continue;
      knownFiles.add(file);
      newEntries.push(createEntry(file, folderId, tagIds));
    }
    appendEntries(newEntries);
  }

  function enqueueFolderFiles(
    items: Array<{ file: File; folderId: string | null; relativePath?: string; overwriteFileId?: string }>,
    tagIds: string[],
    batchId?: string,
  ) {
    const newEntries: QueueEntry[] = [];
    const seenInBatch = new Set<string>();
    for (const item of items) {
      if (!item.file || hasActiveFile(item.file)) continue;
      const batchKey = `${item.folderId ?? 'root'}:${item.file.name}`;
      if (seenInBatch.has(batchKey)) continue;
      seenInBatch.add(batchKey);
      knownFiles.add(item.file);
      const entry = createEntry(item.file, item.folderId, tagIds);
      entry.relativePath = item.relativePath || undefined;
      entry.batchId = batchId;
      entry.overwriteFileId = item.overwriteFileId;
      newEntries.push(entry);
    }
    appendEntries(newEntries);
  }

  function cancelOne(uid: string) {
    const entry = entryByUid.get(uid);
    if (!entry || isTerminal(entry.status)) return;
    if (entry.status === 'pending') {
      changeStatus(entry, 'cancelled');
      finalizeEntry(entry);
      return;
    }
    controllers.get(uid)?.abort();
    const uploadId = chunkedSessions.get(uid)?.uploadId.value;
    if (uploadId) api.post(`/files/chunk/${uploadId}/abort`).catch(() => {});
  }

  function cancelAll() {
    for (const entry of entries.value) if (!isTerminal(entry.status)) cancelOne(entry.uid);
  }

  function clearFinished() {
    const retained: QueueEntry[] = [];
    for (const entry of entries.value) {
      if (isTerminal(entry.status)) {
        entryByUid.delete(entry.uid);
        totalBytes.value -= entry.totalBytes;
        loadedBytes.value -= entry.loadedBytes;
        if (entry.status === 'success') successCount.value--;
        else if (entry.status === 'error') errorCount.value--;
        else cancelledCount.value--;
      } else retained.push(entry);
    }
    entries.value = retained;
  }

  function setFileConcurrency(n: number) {
    fileConcurrency.value = Math.min(4, Math.max(1, Math.floor(n)));
    if (queuedCount.value > 0) ensurePump();
  }

  return {
    entries,
    isPumping,
    fileConcurrency,
    activeCount,
    queuedCount,
    successCount,
    errorCount,
    cancelledCount,
    finishedCount,
    overallProgress,
    overallSpeed,
    enqueue,
    enqueueFolderFiles,
    cancelOne,
    cancelAll,
    clearFinished,
    setFileConcurrency,
    flushProgress,
  };
});
