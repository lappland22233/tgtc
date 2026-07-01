import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from './auth';
import type { BatchUploadResult, FileItem } from '../types/file';

export const useFileStore = defineStore('files', () => {
  const files = ref<FileItem[]>([]);
  const total = ref(0);
  const loading = ref(false);
  // 取消上一次 fetchFiles 请求，避免并发；用户快速刷新时新请求优先
  let fetchAbortController: AbortController | null = null;

  /** 当前用户是否为管理员（供 UI 判断恢复按钮是否可用） */
  const currentUserRole = ref<string>('user');

  function setCurrentUserRole(role: string) {
    currentUserRole.value = role;
  }

  async function fetchFiles(page = 1, limit = 20, keyword?: string) {
    // 取消上一次请求（如有）
    if (fetchAbortController) {
      fetchAbortController.abort();
    }
    fetchAbortController = new AbortController();
    loading.value = true;
    try {
      const response = await api.get('/files', {
        params: { page, limit, keyword, includeDeleted: 'true' },
        signal: fetchAbortController.signal,
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
      loading.value = false;
      fetchAbortController = null;
    }
  }

  async function uploadFile(
    file: File,
    onProgress?: (loaded: number, total: number) => void,
  ) {
    const formData = new FormData();
    formData.append('file', file);
    const response = await api.post('/files/upload', formData, {
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
   */
  async function uploadFileAsync(
    file: File,
    onProgress?: (loaded: number, total: number) => void,
    onStatusChange?: (status: string) => void,
  ) {
    const formData = new FormData();
    formData.append('file', file);
    // Step 1: 上传文件（Multer 缓冲阶段，有上传进度）
    const response = await api.post('/files/upload-async', formData, {
      onUploadProgress: (progressEvent) => {
        if (progressEvent.total && onProgress) {
          onProgress(progressEvent.loaded, progressEvent.total);
        }
      },
    });
    const { jobId } = response.data.data;

    // Step 2: 轮询上传状态（Telegram 转发阶段）
    // 使用 AbortController 支持取消轮询（组件卸载或路由切换时）
    const abortController = new AbortController();
    const pollInterval = 1000; // 1 秒轮询
    const maxWait = 10 * 60 * 1000; // 最多等 10 分钟
    const startTime = Date.now();

    try {
      while (!abortController.signal.aborted && Date.now() - startTime < maxWait) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        if (abortController.signal.aborted) {
          throw new Error('上传已被取消');
        }
        const statusRes = await api.get(`/files/upload-status/${jobId}`, {
          signal: abortController.signal,
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
    } finally {
      // 确保组件卸载或任务完成后清理轮询
      abortController.abort();
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

  return {
    files,
    total,
    loading,
    currentUserRole,
    setCurrentUserRole,
    fetchFiles,
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
  };
});
