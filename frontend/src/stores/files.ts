import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from './auth';
import type { BatchUploadResult, FileItem } from '../types/file';

export const useFileStore = defineStore('files', () => {
  const files = ref<FileItem[]>([]);
  const total = ref(0);
  const loading = ref(false);
  // 取消上一次 fetchFiles 请求，避免并发；用户快速刷新时新请求优先
  // 不同操作使用独立 AbortController，防止互相干扰
  let listAbortController: AbortController | null = null;
  let cursorAbortController: AbortController | null = null;

  // 列表请求计数器：fetchFiles 与 fetchFilesCursor 共享同一个 loading 状态，
  // 仅当所有进行中的列表请求都结束时才清除 loading，避免并发时互相提前复位加载态。
  let activeListRequests = 0;
  function beginListRequest() {
    activeListRequests++;
    loading.value = true;
  }
  function endListRequest() {
    activeListRequests = Math.max(0, activeListRequests - 1);
    if (activeListRequests === 0) loading.value = false;
  }

  /** 当前用户是否为管理员（供 UI 判断恢复按钮是否可用） */
  const currentUserRole = ref<string>('user');

  function setCurrentUserRole(role: string) {
    currentUserRole.value = role;
  }

  async function fetchFiles(page = 1, limit = 20, keyword?: string, sortBy?: string, sortOrder?: string, tagIds?: string[], folderId?: string) {
    // 取消上一次请求（如有）
    if (listAbortController) {
      listAbortController.abort();
    }
    const controller = new AbortController();
    listAbortController = controller;
    beginListRequest();
    try {
      const response = await api.get('/files', {
        params: { page, limit, keyword, includeDeleted: 'true', sortBy, sortOrder, tagIds: tagIds?.join(','), folderId },
        signal: controller.signal,
      });
      files.value = response.data.data.files;
      total.value = response.data.data.total;
    } catch (err) {
      // 忽略 AbortError（被新请求取消的旧请求）
      const axiosErr = err as { name?: string; code?: string };
      if (axiosErr.name === 'AbortError' || axiosErr.code === 'ERR_CANCELED') {
        return;
      }
      throw err;
    } finally {
      endListRequest();
      // 仅当当前控制器未被替换时才清除引用（防止旧请求的 finally 覆盖新请求的控制器）
      if (listAbortController === controller) {
        listAbortController = null;
      }
    }
  }

  /**
   * 游标分页请求（无限滚动模式使用）
   * 返回 { files, nextCursor, total } 供 useCursorPagination 使用
   */
  async function fetchFilesCursor(limit: number, keyword?: string, cursor?: string | null, tagIds?: string[], externalSignal?: AbortSignal, folderId?: string) {
    if (cursorAbortController) {
      cursorAbortController.abort();
    }
    const controller = new AbortController();
    cursorAbortController = controller;

    // 监听外部 AbortSignal（来自 useCursorPagination 的 generation reset）
    if (externalSignal) {
      if (externalSignal.aborted) {
        return { files: [] as FileItem[], nextCursor: cursor ?? null, total: total.value };
      }
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    beginListRequest();
    try {
      const params: Record<string, unknown> = { limit, includeDeleted: 'true' };
      if (keyword) params.keyword = keyword;
      if (cursor) params.cursor = cursor;
      if (tagIds?.length) params.tagIds = tagIds.join(',');
      if (folderId) params.folderId = folderId;

      const response = await api.get('/files', { params, signal: controller.signal });
      const data = response.data.data;
      total.value = data.total;
      return {
        files: data.files as FileItem[],
        nextCursor: data.nextCursor as string | null,
        total: data.total as number,
      };
    } catch (err) {
      const axiosErr = err as { name?: string; code?: string };
      if (axiosErr.name === 'AbortError' || axiosErr.code === 'ERR_CANCELED') {
        // 返回空数据 + hasMore: true，避免 useCursorPagination 误判为"无更多数据"
        // 上游的 generation 检查会丢弃此结果
        return { files: [] as FileItem[], nextCursor: cursor ?? null, total: total.value };
      }
      throw err;
    } finally {
      endListRequest();
      if (cursorAbortController === controller) {
        cursorAbortController = null;
      }
    }
  }

  /** 替换整个文件列表（无限模式从头加载时使用） */
  function replaceFiles(newFiles: FileItem[]) {
    files.value = newFiles;
  }

  async function uploadFile(
    file: File,
    onProgress?: (loaded: number, total: number) => void,
  ) {
    const formData = new FormData();
    formData.append('file', file);
    const response = await api.post('/files/upload', formData, {
      // 覆盖默认 30s 超时：大文件在慢网络下上传耗时可能远超 30s，避免被中断
      timeout: 0,
      onUploadProgress: (progressEvent) => {
        if (progressEvent.total && onProgress) {
          onProgress(progressEvent.loaded, progressEvent.total);
        }
      },
    });
    return response.data.data;
  }

  /**
   * 异步上传（大文件专用）：文件传输完成后立即返回 jobId，
   * 通过轮询 upload-status 获取最终结果，防止 CDN/代理超时断开连接。
   *
   * @param signal 可选的取消信号。传入后，上传请求与状态轮询都会响应 abort，
   *               组件卸载或路由切换时可中止，避免轮询最长跑 10 分钟造成内存泄漏与无效流量。
   */
  async function uploadFileAsync(
    file: File,
    onProgress?: (loaded: number, total: number) => void,
    onStatusChange?: (status: string) => void,
    signal?: AbortSignal,
  ) {
    const formData = new FormData();
    formData.append('file', file);
    // Step 1: 上传文件（Multer 缓冲阶段，有上传进度）— 同样响应外部取消
    const response = await api.post('/files/upload-async', formData, {
      signal,
      onUploadProgress: (progressEvent) => {
        if (progressEvent.total && onProgress) {
          onProgress(progressEvent.loaded, progressEvent.total);
        }
      },
    });
    const { jobId } = response.data.data;

    // Step 2: 轮询上传状态（Telegram 转发阶段）
    const pollInterval = 1000; // 1 秒轮询
    const maxWait = 10 * 60 * 1000; // 最多等 10 分钟
    const startTime = Date.now();

    // 可中断的 sleep：到时 resolve；signal abort 时立即 reject 并清理定时器/监听器
    const abortableSleep = (ms: number) => new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('上传已取消'));
        return;
      }
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      const onAbort = () => { cleanup(); reject(new Error('上传已取消')); };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    try {
      while (!signal?.aborted && Date.now() - startTime < maxWait) {
        await abortableSleep(pollInterval);
        if (signal?.aborted) {
          throw new Error('上传已取消');
        }
        const statusRes = await api.get(`/files/upload-status/${jobId}`, {
          signal,
        });
        const job = statusRes.data.data;

        if (onStatusChange) {
          onStatusChange(job.status);
        }

        if (job.status === 'completed') {
          return job.result;
        }
        if (job.status === 'failed') {
          throw new Error(job.error || '上传处理失败');
        }
      }
      throw new Error('上传处理超时');
    } catch (err) {
      // 由 abort 触发的取消（axios CanceledError / 中断的 sleep）统一归一化为业务取消信息
      if (signal?.aborted) {
        throw new Error('上传已取消');
      }
      throw err;
    }
  }

  /**
   * 请求删除文件（延迟删除机制，7 天冷静期）
   * 删除后文件保留在列表中，显示"删除中"状态
   * 返回 { status, scheduledAt } 供 UI 显示状态
   */
  async function deleteFile(id: string) {
    const result = await api.delete(`/files/${id}`);
    const data = result.data?.data || {};
    const file = files.value.find((f) => f.id === id);

    if (file) {
      if (data.status === 'permanently_deleted') {
        // 强制删除：从列表移除
        files.value = files.value.filter((f) => f.id !== id);
        total.value = Math.max(0, total.value - 1);
      } else if (data.status === 'already_deleted') {
        // 已删除：更新本地状态确保一致
        file.isDeleted = true;
        if (data.scheduledAt) file.deleteScheduledAt = data.scheduledAt;
      } else {
        // 首次删除：标记为待删除
        file.isDeleted = true;
        file.deletedByAdmin = false;
        file.deleteRequestedAt = new Date().toISOString();
        if (data.scheduledAt) file.deleteScheduledAt = data.scheduledAt;
      }
    }
    return { status: data.status || 'pending', scheduledAt: data.scheduledAt };
  }

  /** 恢复已删除的文件 */
  async function restoreFile(id: string) {
    await api.post(`/files/${id}/restore`);
    // 更新本地文件状态
    const file = files.value.find((f) => f.id === id);
    if (file) {
      file.isDeleted = false;
      file.deletedByAdmin = false;
      file.deleteRequestedAt = null;
      file.deleteScheduledAt = null;
    }
  }

  /** 强制永久删除文件（文件主自己删除，跳过 7 天等待期） */
  async function forceDeleteFile(id: string) {
    await api.post(`/files/${id}/force-delete`);
    // 永久删除后从本地列表移除
    files.value = files.value.filter((f) => f.id !== id);
    total.value = Math.max(0, total.value - 1);
  }

  async function uploadMultiple(files: File[]): Promise<BatchUploadResult> {
    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));
    const response = await api.post('/files/upload-multiple', formData);
    return response.data.data;
  }

  async function updateAccessType(id: string, accessType: string) {
    await api.put(`/files/${id}/access-type`, { accessType });
  }

  async function updateAccessCount(id: string, maxAccessCount: number) {
    await api.put(`/files/${id}/access-count`, { maxAccessCount });
  }

  async function updateExpires(id: string, expiresIn: number | null) {
    await api.put(`/files/${id}/expires`, { expiresIn });
  }

  async function setPassword(id: string, password: string) {
    await api.put(`/files/${id}/password`, { password });
  }

  /** 重命名文件（仅修改显示名） */
  async function renameFile(id: string, name: string) {
    const res = await api.patch(`/files/${id}/rename`, { name });
    // 同步更新本地列表中对应文件的显示名
    const file = files.value.find((f) => f.id === id);
    if (file) file.originalName = res.data.data.originalName;
    return res.data.data;
  }

  /** 复制文件（生成副本，复用同一底层存储）；folderId 为 null 表示复制到根目录 */
  async function copyFile(id: string, folderId: string | null = null) {
    const res = await api.post(`/files/${id}/copy`, { folderId });
    return res.data.data;
  }

  return {
    files,
    total,
    loading,
    currentUserRole,
    setCurrentUserRole,
    fetchFiles,
    fetchFilesCursor,
    replaceFiles,
    uploadFile,
    uploadFileAsync,
    uploadMultiple,
    deleteFile,
    restoreFile,
    forceDeleteFile,
    updateAccessType,
    updateAccessCount,
    updateExpires,
    setPassword,
    renameFile,
    copyFile,
  };
});
