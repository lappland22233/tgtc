import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from './auth';
import type { BatchUploadResult, FileItem } from '../types/file';

export const useFileStore = defineStore('files', () => {
  const files = ref<FileItem[]>([]);
  const total = ref(0);
  const loading = ref(false);

  async function fetchFiles(page = 1, limit = 20, keyword?: string) {
    if (loading.value) return; // 防止并发重复请求
    loading.value = true;
    try {
      const response = await api.get('/files', { params: { page, limit, keyword } });
      files.value = response.data.data.files;
      total.value = response.data.data.total;
    } finally {
      loading.value = false;
    }
  }

  async function uploadFile(
    file: File,
    onProgress?: (loaded: number, total: number) => void,
  ) {
    const formData = new FormData();
    formData.append('file', file);
    const response = await api.post('/files/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (progressEvent) => {
        if (progressEvent.total && onProgress) {
          onProgress(progressEvent.loaded, progressEvent.total);
        }
      },
    });
    return response.data.data;
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
    const response = await api.post('/files/upload-multiple', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
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
    uploadMultiple,
    deleteFile,
    updateAccessType,
    updateAccessCount,
    updateExpires,
    setPassword,
  };
});
