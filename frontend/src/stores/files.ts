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

  async function fetchFiles(page = 1, limit = 20, keyword?: string) {
    // 取消上一次请求（如有）
    if (fetchAbortController) {
      fetchAbortController.abort();
    }
    fetchAbortController = new AbortController();
    loading.value = true;
    try {
      const response = await api.get('/files', {
        params: { page, limit, keyword },
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
    const pollInterval = 1000; // 1 秒轮询
    const maxWait = 10 * 60 * 1000; // 最多等 10 分钟
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      const statusRes = await api.get(`/files/upload-status/${jobId}`);
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
  }

  async function deleteFile(id: string) {
    await api.delete(`/files/${id}`);
    // 仅服务器确认删除后再从本地列表移除
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
    fetchFiles,
    uploadFile,
    uploadFileAsync,
    uploadMultiple,
    deleteFile,
    updateAccessType,
    updateAccessCount,
    updateExpires,
    setPassword,
  };
});
