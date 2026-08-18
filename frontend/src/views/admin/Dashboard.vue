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
        <div class="value" style="color: var(--color-success);">{{ stats.activeUsers }}</div>
      </div>
      <div class="stat-card">
        <h3>已封禁用户</h3>
        <div class="value" style="color: var(--color-danger);">{{ stats.bannedUsers }}</div>
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
        <div class="value" style="color: var(--color-cyan);">{{ stats.totalAccessCount }}</div>
      </div>
    </div>

    <div class="dashboard-split-grid">
      <div class="card">
        <h3 class="card-title">
          我的文件统计
        </h3>
        <div class="stats-grid nested-stats">
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
            <div class="value" style="color: var(--color-cyan);">{{ myFiles.totalAccessCount }}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <h3 class="card-title">
          全站月度访问量
        </h3>
        <div v-if="stats.monthlyAccess.length === 0" class="empty-state">
          <p>暂无访问数据</p>
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
import { shallowRef, computed, onMounted, onUnmounted } from 'vue';
import { formatSize } from '@/utils/format';
import { api } from '../../stores/auth';

const stats = shallowRef({
  totalUsers: 0,
  activeUsers: 0,
  bannedUsers: 0,
  totalFiles: 0,
  totalStorage: 0,
  totalAccessCount: 0,
  monthlyAccess: [] as { month: string; count: number }[],
});

const myFiles = shallowRef({
  fileCount: 0,
  totalSize: 0,
  totalAccessCount: 0,
});

let refreshTimer: number;

async function fetchData() {
  try {
    const statsRes = await api.get('/admin/stats');
    stats.value = statsRes.data.data;
  } catch { /* 保留默认值 */ }
  try {
    const myFilesRes = await api.get('/admin/my-files-stats');
    myFiles.value = myFilesRes.data.data;
  } catch { /* 保留默认值 */ }
}

function formatMonth(month: string) {
  const m = month.split('-')[1];
  const n = parseInt(m, 10);
  if (Number.isNaN(n)) return month;
  return `${n}月`;
}

// 缓存最大访问量，避免 getBarHeight 每次调用都重新 map+Math.max（O(n²)→O(n)）
const maxAccessCount = computed(() =>
  Math.max(...stats.value.monthlyAccess.map((i) => i.count), 1),
);

function getBarHeight(count: number) {
  return Math.max(4, Math.round((count / maxAccessCount.value) * 120)) + 'px';
}

onMounted(async () => {
  await fetchData();
  refreshTimer = window.setInterval(() => {
    // 后台标签页不轮询，避免空转（G15-27）
    if (document.hidden) return;
    void fetchData();
  }, 30_000);
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<style scoped>
.dashboard-split-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

/* 嵌套统计网格：桌面 3 列，移动端塌缩为 1 列（替代原 inline style，解决小屏挤压） */
.nested-stats {
  margin-bottom: 0;
  grid-template-columns: repeat(3, 1fr);
}

@media (max-width: 768px) {
  .dashboard-split-grid {
    grid-template-columns: 1fr;
  }
  .nested-stats {
    grid-template-columns: 1fr;
  }
}
</style>
