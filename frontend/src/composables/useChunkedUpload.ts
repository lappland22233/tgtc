import { ref } from 'vue';
import api from '../api/client';

export interface ChunkUploadProgress {
  totalChunks: number;
  uploadedChunks: number;
  totalBytes: number;
  loadedBytes: number;
  speed: string;
  eta: string;
  retrying?: boolean;
}

export interface ChunkUploadResult {
  id: string;
  originalName: string;
}

/** 分片大小选项：逐级缩小以适应慢速网络 */
const CHUNK_SIZE_OPTIONS = [
  5 * 1024 * 1024,   // 5MB  — 快速网络
  2 * 1024 * 1024,   // 2MB  — 中等网络
  1 * 1024 * 1024,   // 1MB  — 慢速网络
  512 * 1024,        // 512KB — 极慢网络
];

/** 
 * 单个分片超时时间 (ms)，超过此时间视为超时。
 * Cloudflare 免费/Pro 套餐代理超时 100 秒，前端需在 100 秒内主动 abort，
 * 否则 Cloudflare 先返回 502 导致错误信息不明确。
 * 设为 90 秒留 10 秒安全余量。
 */
const CHUNK_TIMEOUT = 90 * 1000;

/** 最大重试次数 */
const MAX_RETRIES = 3;

/** 重试退避基数 (ms) */
const RETRY_BASE_DELAY = 2000;

/**
 * 分片上传 composable
 * 支持断点续传、自动重试、速度自适应分片大小
 */
export function useChunkedUpload(concurrency = 2) {
  const uploadId = ref<string | null>(null);
  const progress = ref<ChunkUploadProgress>({
    totalChunks: 0,
    uploadedChunks: 0,
    totalBytes: 0,
    loadedBytes: 0,
    speed: '-',
    eta: '-',
  });
  const uploading = ref(false);

  let checkpointTime = 0;
  let checkpointBytes = 0;

  /**
   * 上传单文件（自适应分片 + 断点续传 + 自动重试）
   */
  async function uploadFile(
    file: File,
    onProgress?: (p: ChunkUploadProgress) => void,
    signal?: AbortSignal,
    chunkSizeHint = CHUNK_SIZE_OPTIONS[0],
  ): Promise<ChunkUploadResult> {
    uploading.value = true;
    uploadId.value = null;

    // 自适应分片大小：根据文件大小选择合适的 chunk size
    let chunkSize = chunkSizeHint;
    if (file.size < 10 * 1024 * 1024) {
      chunkSize = Math.min(chunkSize, 1 * 1024 * 1024);
    }
    const totalChunks = Math.ceil(file.size / chunkSize);

    try {
      // 1. Init
      const initRes = await api.post('/files/chunk/init', {
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        totalChunks,
        chunkSize,
      }, { signal, timeout: 0 });
      uploadId.value = initRes.data.data.uploadId;

      // 2. Get uploaded status
      const statusRes = await api.get(`/files/chunk/${uploadId.value}/status`, { signal });
      const uploadedSet = new Set<number>(statusRes.data.data.uploaded);

      // 3. Prepare pending chunks
      const pendingChunks: { index: number; blob: Blob }[] = [];
      for (let i = 0; i < totalChunks; i++) {
        if (!uploadedSet.has(i)) {
          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, file.size);
          pendingChunks.push({ index: i, blob: file.slice(start, end) });
        }
      }

      progress.value = {
        totalChunks,
        uploadedChunks: uploadedSet.size,
        totalBytes: file.size,
        loadedBytes: uploadedSet.size * chunkSize,
        speed: '-',
        eta: '-',
      };

      let completed = uploadedSet.size;
      let consecutiveTimeouts = 0;
      checkpointTime = Date.now();
      checkpointBytes = 0;
      const activeChunkSize = chunkSize;

      /**
       * 上传单个分片（含自动重试和自适应分片降级）
       */
      const uploadChunk = async (chunk: { index: number; blob: Blob }, retryCount = 0): Promise<void> => {
        if (signal?.aborted) return;

        try {
          const form = new FormData();
          form.append('chunk', chunk.blob, String(chunk.index));
          form.append('index', String(chunk.index));

          // 单个分片请求超时控制
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), CHUNK_TIMEOUT);
          const mergedSignal = signal
            ? combineSignals(signal, controller.signal)
            : controller.signal;

          await api.post(`/files/chunk/${uploadId.value}`, form, {
            signal: mergedSignal,
            timeout: 0, // 禁用 axios 默认 30s 超时，使用 AbortController 控制
          });
          clearTimeout(timeoutId);
        } catch (err: any) {
          // 取消不重试
          if (err?.name === 'AbortError' || err?.code === 'ERR_CANCELED') {
            if (signal?.aborted) return;
          }

          // 可重试的错误：超时、网络错误、5xx、Cloudflare 502
          const isRetryable =
            err?.code === 'ECONNABORTED' ||
            err?.code === 'ERR_NETWORK' ||
            err?.message?.includes('timeout') ||
            err?.message?.includes('代理层') ||       // Cloudflare 代理层错误（413/502 非 JSON 响应）
            err?.response?.status >= 500;

          if (isRetryable && retryCount < MAX_RETRIES) {
            const delay = RETRY_BASE_DELAY * Math.pow(2, retryCount);
            progress.value.retrying = true;
            onProgress?.(progress.value);

            console.warn(`分片 ${chunk.index} 上传失败，${delay / 1000}s 后重试 (${retryCount + 1}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, delay));

            progress.value.retrying = false;
            onProgress?.(progress.value);

            // 连续超时或 CDN 502 后降级分片大小
            const isTimeout = err?.code === 'ECONNABORTED' || err?.message?.includes('代理层');
            if (isTimeout) {
              consecutiveTimeouts++;
              if (consecutiveTimeouts >= 2 && chunkSize > 512 * 1024) {
                chunkSize = Math.max(512 * 1024, Math.floor(chunkSize / 2));
                console.warn(`CDN 超时频繁，分片大小降级至 ${chunkSize / 1024}KB`);
                consecutiveTimeouts = 0;
              }
            }

            return uploadChunk(chunk, retryCount + 1);
          }

          throw err;
        }

        // 成功：更新进度
        completed++;
        checkpointBytes += chunk.blob.size;
        const now = Date.now();
        const elapsed = now - checkpointTime;
        if (elapsed >= 500 || completed === totalChunks) {
          const loadedBytes = Math.min(completed * activeChunkSize, file.size);
          const speed = elapsed > 0 ? Math.round(checkpointBytes / (elapsed / 1000)) : 0;
          const remaining = totalChunks - completed;
          const eta = speed > 0 ? Math.ceil(remaining * activeChunkSize / speed) : 0;

          progress.value = {
            totalChunks,
            uploadedChunks: completed,
            totalBytes: file.size,
            loadedBytes,
            speed: speed > 0 ? formatSpeed(speed) : '-',
            eta: eta > 0 ? formatETA(eta) : '-',
          };
          onProgress?.(progress.value);

          checkpointTime = now;
          checkpointBytes = 0;
        }
      };

      // 并发上传（滑动窗口）
      let nextIdx = 0;
      const runNext = async (): Promise<void> => {
        const idx = nextIdx++;
        if (idx >= pendingChunks.length) return;
        await uploadChunk(pendingChunks[idx]);
        await runNext();
      };

      await Promise.all(
        Array.from({ length: Math.min(concurrency, pendingChunks.length) }, () => runNext()),
      );

      // 5. Trigger async merge (immediate return, non-blocking), with retry on CDN 502
      let mergeTriggered = false;
      for (let retry = 0; retry < MAX_RETRIES; retry++) {
        try {
          await api.post(`/files/chunk/${uploadId.value}/complete`, {}, { signal, timeout: 0 });
          mergeTriggered = true;
          break;
        } catch (err: any) {
          if (signal?.aborted) throw err;
          const isRetryable =
            err?.code === 'ERR_NETWORK' ||
            err?.message?.includes('代理层') ||
            err?.response?.status >= 500;
          if (!isRetryable || retry >= MAX_RETRIES - 1) throw err;
          console.warn(`[分片上传] 合并触发失败，${RETRY_BASE_DELAY / 1000}s 后重试 (${retry + 1}/${MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, RETRY_BASE_DELAY));
        }
      }
      if (!mergeTriggered) {
        throw new Error('无法启动合并任务，请重试');
      }

      // 6. Poll for merge result (avoids Cloudflare 502 timeout on long-running uploads)
      if (!uploadId.value) throw new Error('上传会话 ID 丢失');
      const result = await pollMergeResult(uploadId.value, signal);
      uploading.value = false;
      return result;
    } catch (err) {
      uploading.value = false;
      if (uploadId.value && !signal?.aborted) {
        await api.post(`/files/chunk/${uploadId.value}/abort`).catch(() => {});
      }
      throw err;
    }
  }

  async function cancel() {
    if (uploadId.value) {
      await api.post(`/files/chunk/${uploadId.value}/abort`).catch(() => {});
      uploadId.value = null;
    }
    uploading.value = false;
  }

  return { uploadFile, cancel, uploadId, progress, uploading };
}

/** 合并两个 AbortSignal */
function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  if (a.aborted || b.aborted) controller.abort();
  return controller.signal;
}

/** 轮询合并状态，避免长时间同步等待触发 CDN 502 */
async function pollMergeResult(
  uploadId: string,
  signal?: AbortSignal,
): Promise<ChunkUploadResult> {
  const maxAttempts = 360; // 最多轮询 30 分钟 (5s * 360)，适配特大文件 Telegram 上传
  let consecutiveFailures = 0;
  const maxConsecutiveFailures = 3;

  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) throw new Error('上传已取消');
    await new Promise(resolve => setTimeout(resolve, 5000));

    try {
      const res = await api.get(`/files/chunk/${uploadId}/status`, { signal });
      const { mergeStatus, mergeResult, mergeError } = res.data.data;

      // 成功获取状态，重置故障计数器
      consecutiveFailures = 0;

      if (mergeStatus === 'done' && mergeResult) {
        return mergeResult;
      }
      if (mergeStatus === 'error') {
        throw new Error(mergeError || '合并失败');
      }
    } catch (err: any) {
      // Cancel/Abort — 直接抛出
      if (err?.name === 'AbortError' || err?.code === 'ERR_CANCELED') {
        throw err;
      }

      // 业务层错误（mergeError 等）— 直接抛出
      if (err?.message && !err?.response && err?.code !== 'ERR_NETWORK') {
        throw err;
      }

      // 网络/代理层错误（502, 520-524, 超时等）— 可重试
      consecutiveFailures++;
      console.warn(
        `[分片上传] 状态轮询失败 (${consecutiveFailures}/${maxConsecutiveFailures}): ${err?.message || err?.code}`,
      );

      if (consecutiveFailures >= maxConsecutiveFailures) {
        throw new Error('服务暂时不可用，合并仍在后台进行，请稍后刷新文件列表查看');
      }

      // 退避重试：2s, 4s, 8s
      const delay = 2000 * Math.pow(2, consecutiveFailures - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('合并处理中，请稍后刷新文件列表查看；如文件未出现，请重新上传');
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatETA(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
