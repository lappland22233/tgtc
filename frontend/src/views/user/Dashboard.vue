<template>
  <div>
    <div class="page-header">
      <h1>仪表盘</h1>
      <p>欢迎使用文件分发系统</p>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <h3>我的文件</h3>
        <div class="value">{{ stats.fileCount }}</div>
      </div>
      <div class="stat-card">
        <h3>总存储</h3>
        <div class="value">{{ formatSize(stats.totalSize) }}</div>
      </div>
      <div class="stat-card">
        <h3>今日上传</h3>
        <div class="value">{{ todayUploads }}</div>
      </div>
      <div class="stat-card">
        <h3>总访问次数</h3>
        <div class="value">{{ stats.totalAccessCount }}</div>
      </div>
      <div class="stat-card">
        <h3>账户类型</h3>
        <div class="value" style="font-size: 18px;">{{ roleText }}</div>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-bottom: 16px;">最近上传</h3>
      <t-loading v-if="loading" />
      <div v-else-if="recentFiles.length === 0" style="text-align: center; padding: 32px; color: var(--text-secondary);">
        暂无文件上传记录
      </div>
      <div v-else class="file-list">
        <div v-for="file in recentFiles" :key="file.id" class="file-item">
          <div class="file-icon" :class="getFileIcon(file.mimeType)">
            {{ getFileEmoji(file.mimeType) }}
          </div>
          <div class="file-info">
            <div class="file-name">{{ file.originalName }}</div>
            <div class="file-meta">
              {{ formatSize(file.size) }} · {{ formatDate(file.createdAt) }}
            </div>
          </div>
          <div class="file-actions">
            <t-tag :theme="file.accessType === 'public' ? 'success' : 'warning'">
              {{ file.accessType === 'public' ? '公开' : '私有' }}
            </t-tag>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api } from '../../stores/auth';
import { storeToRefs } from 'pinia';
import { useAuthStore } from '../../stores/auth';
import { formatSize, formatDate, getFileEmoji } from '@/utils/format';
import type { UserRole } from '../../types/user';
import type { FileItem } from '../../types/file';

const authStore = useAuthStore();
const { user } = storeToRefs(authStore);

const stats = ref({ fileCount: 0, totalSize: 0, totalAccessCount: 0 });
const recentFiles = ref<FileItem[]>([]);
const loading = ref(true);

const roleText = computed(() => {
  const map: Record<UserRole, string> = { super_admin: '超级管理员', admin: '管理员', user: '普通用户' };
  return map[user.value?.role ?? 'user'] || '普通用户';
});

const todayUploads = computed(() => {
  const today = new Date().toDateString();
  return recentFiles.value.filter(f => new Date(f.createdAt).toDateString() === today).length;
});

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.includes('pdf')) return 'pdf';
  return 'default';
}

onMounted(async () => {
  // 使用 Promise.allSettled 确保单个请求失败不影响整体页面
  const [statsResult, filesResult] = await Promise.allSettled([
    api.get('/users/me/stats'),
    api.get('/files?limit=5'),
  ]);
  if (statsResult.status === 'fulfilled') {
    stats.value = statsResult.value.data.data;
  }
  if (filesResult.status === 'fulfilled') {
    recentFiles.value = filesResult.value.data.data.files;
  }
  loading.value = false;
});
</script>
