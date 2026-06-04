<template>
  <div>
    <div class="page-header">
      <h1>管理后台</h1>
      <p>系统运行概览和数据统计</p>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <h3>总用户数</h3>
        <div class="value">{{ stats.totalUsers }}</div>
      </div>
      <div class="stat-card">
        <h3>活跃用户</h3>
        <div class="value" style="color: var(--success);">{{ stats.activeUsers }}</div>
      </div>
      <div class="stat-card">
        <h3>已封禁用户</h3>
        <div class="value" style="color: var(--error);">{{ stats.bannedUsers }}</div>
      </div>
      <div class="stat-card">
        <h3>总文件数</h3>
        <div class="value">{{ stats.totalFiles }}</div>
      </div>
      <div class="stat-card">
        <h3>总存储量</h3>
        <div class="value">{{ formatSize(stats.totalStorage) }}</div>
      </div>
      <div class="stat-card">
        <h3>全站总访问</h3>
        <div class="value">{{ stats.totalAccessCount }}</div>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
      <div class="card">
        <h3 style="margin-bottom: 16px;">我的文件统计</h3>
        <div class="stats-grid">
          <div class="stat-card">
            <h3>我的文件</h3>
            <div class="value">{{ myFiles.fileCount }}</div>
          </div>
          <div class="stat-card">
            <h3>我的存储</h3>
            <div class="value">{{ formatSize(myFiles.totalSize) }}</div>
          </div>
          <div class="stat-card">
            <h3>我的访问次数</h3>
            <div class="value">{{ myFiles.totalAccessCount }}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-bottom: 16px;">全站月度访问量</h3>
        <div v-if="stats.monthlyAccess.length === 0" style="text-align: center; padding: 24px; color: var(--text-secondary);">
          暂无访问数据
        </div>
        <div v-else class="monthly-chart">
          <div class="chart-bars">
            <div
              v-for="item in stats.monthlyAccess"
              :key="item.month"
              class="chart-bar-wrapper"
              :title="`${item.month}: ${item.count} 次`"
            >
              <div class="chart-bar-label">{{ item.count }}</div>
              <div
                class="chart-bar"
                :style="{ height: getBarHeight(item.count) }"
              ></div>
              <div class="chart-bar-month">{{ formatMonth(item.month) }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../../stores/auth';

const stats = ref({
  totalUsers: 0,
  activeUsers: 0,
  bannedUsers: 0,
  totalFiles: 0,
  totalStorage: 0,
  totalAccessCount: 0,
  monthlyAccess: [] as { month: string; count: number }[],
});

const myFiles = ref({
  fileCount: 0,
  totalSize: 0,
  totalAccessCount: 0,
});

const currentTime = ref('');
let timer: number;

function formatSize(bytes: number) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatMonth(month: string) {
  const m = month.split('-')[1];
  return `${parseInt(m)}月`;
}

function getBarHeight(count: number) {
  const max = Math.max(...stats.value.monthlyAccess.map((i) => i.count), 1);
  return Math.max(4, Math.round((count / max) * 120)) + 'px';
}

function updateTime() {
  currentTime.value = new Date().toLocaleString('zh-CN');
}

onMounted(async () => {
  // 独立 try-catch 确保单个请求失败不影响其他数据
  try {
    const statsRes = await api.get('/admin/stats');
    stats.value = statsRes.data.data;
  } catch {
    // 保留默认值
  }
  try {
    const myFilesRes = await api.get('/admin/my-files-stats');
    myFiles.value = myFilesRes.data.data;
  } catch {
    // 保留默认值
  }
  updateTime();
  timer = window.setInterval(updateTime, 1000);
});

onUnmounted(() => {
  clearInterval(timer);
});
</script>
