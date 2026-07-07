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
      // 静默失败，标签非核心功能
      console.error('获取标签列表失败:', err);
    } finally {
      loading.value = false;
    }
  }

  async function createTag(name: string, color?: string) {
    const response = await api.post('/tags', { name, color });
    const newTag = response.data.data;
    tags.value.push(newTag);
    return newTag as Tag;
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
