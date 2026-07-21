import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from './auth';
import type { Tag } from '../types/file';

export const useTagStore = defineStore('tags', () => {
  const tags = ref<Tag[]>([]);
  const loading = ref(false);

  async function fetchTags() {
    loading.value = true;
    try {
      const response = await api.get('/tags');
      tags.value = response.data.data.tags;
    } catch (err) {
      // 静默失败，标签非核心功能。仅记录简要信息，避免输出原始错误对象泄漏内部细节
      console.error('获取标签列表失败:', err instanceof Error ? err.message : '未知错误');
    } finally {
      loading.value = false;
    }
  }

  // 进行中的同名创建请求映射：防止快速双击/并发导致重复创建与重复 push
  const creatingTags = new Map<string, Promise<Tag>>();

  async function createTag(name: string, color?: string): Promise<Tag> {
    // 防重 1：本地已存在同名标签，直接返回，避免重复 push
    const existing = tags.value.find((t) => t.name === name);
    if (existing) return existing;

    // 防重 2：同名创建请求进行中，复用其结果
    const pending = creatingTags.get(name);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const response = await api.post('/tags', { name, color });
        const newTag = response.data.data as Tag;
        // 双重校验：请求期间若已新增同名/同 id 标签（如其他标签页同步），不重复 push
        if (!tags.value.some((t) => t.id === newTag.id || t.name === newTag.name)) {
          tags.value.push(newTag);
        }
        return newTag;
      } finally {
        creatingTags.delete(name);
      }
    })();

    creatingTags.set(name, promise);
    return promise;
  }

  async function updateTag(id: string, data: { name?: string; color?: string }) {
    const response = await api.put(`/tags/${id}`, data);
    const updated = response.data.data as Tag;
    const idx = tags.value.findIndex((t) => t.id === id);
    if (idx !== -1) tags.value[idx] = updated;
    return updated;
  }

  async function deleteTag(id: string) {
    await api.delete(`/tags/${id}`);
    tags.value = tags.value.filter((t) => t.id !== id);
  }

  return { tags, loading, fetchTags, createTag, updateTag, deleteTag };
});
