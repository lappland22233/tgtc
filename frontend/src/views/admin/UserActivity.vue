<template>
  <div class="user-activity-page">
    <div class="page-header">
      <h1>用户活跃</h1>
      <p>用户活跃度分析与活跃排行榜</p>
    </div>

    <!-- Time Range Selector -->
    <div class="toolbar">
      <t-radio-group v-model="timeRange" variant="default-filled" @change="fetchData">
        <t-radio-button value="1h">1小时</t-radio-button>
        <t-radio-button value="24h">24小时</t-radio-button>
        <t-radio-button value="7d">7天</t-radio-button>
        <t-radio-button value="30d">30天</t-radio-button>
      </t-radio-group>
    </div>

    <t-loading :loading="loading" size="small">
      <template v-if="data">
        <!-- Stat Cards -->
        <div class="metrics-grid">
          <div class="metric-card">
            <div class="metric-label">DAU (日活跃用户)</div>
            <div class="metric-value">{{ data.dau }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">WAU (周活跃用户)</div>
            <div class="metric-value">{{ data.wau }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">MAU (月活跃用户)</div>
            <div class="metric-value">{{ data.mau }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">新增用户</div>
            <div class="metric-value">{{ data.newUsers }}</div>
          </div>
        </div>

        <!-- Top Active Users -->
        <div class="card">
          <h3>Top 活跃用户</h3>
          <t-table
            :data="data.topActiveUsers"
            :columns="userColumns"
            row-key="userId"
            table-layout="fixed"
            :pagination="false"
            size="small"
            max-height="500"
          >
            <template #userId="{ row }">
              <t-tooltip placement="top" :content="row.userId">
                <span class="truncated-cell">{{ row.userId.substring(0, 8) }}</span>
              </t-tooltip>
            </template>
            <template #lastSeen="{ row }">
              {{ formatDate(row.lastSeen) }}
            </template>
          </t-table>
          <div v-if="!data.topActiveUsers.length" class="empty-hint">暂无活跃用户数据</div>
        </div>
      </template>
      <div v-else-if="!loading" class="empty-hint">暂无数据</div>
    </t-loading>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '@/stores/auth';
import { formatDate } from '@/utils/format';

interface UserActivityResponse {
  dau: number;
  wau: number;
  mau: number;
  newUsers: number;
  topActiveUsers: { userId: string; ip: string; requestCount: number; lastSeen: string }[];
}

const timeRange = ref('30d');
const loading = ref(false);
const data = ref<UserActivityResponse | null>(null);

const userColumns = [
  { colKey: 'userId', title: '用户ID', width: 120 },
  { colKey: 'ip', title: 'IP 地址', width: 150 },
  { colKey: 'requestCount', title: '请求数', width: 100 },
  { colKey: 'lastSeen', title: '最后活跃', width: 140 },
];

async function fetchData() {
  loading.value = true;
  try {
    const { data: res } = await api.get('/admin/user-activity/stats', {
      params: { timeRange: timeRange.value },
    });
    data.value = (res.data || res) as UserActivityResponse;
  } catch {
    data.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  fetchData();
});
</script>

<style scoped>
.user-activity-page {
  padding: 0;
}

.page-header {
  margin-bottom: 24px;
}

.page-header h1 {
  font-size: 24px;
  font-weight: 600;
  margin: 0 0 4px;
}

.page-header p {
  color: var(--text-secondary);
  font-size: 14px;
  margin: 0;
}

.toolbar {
  margin-bottom: 20px;
}

/* Metrics grid */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.metric-card {
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
  padding: 20px;
}

.metric-label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.metric-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
}

/* Card */
.card {
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
  padding: 20px;
}

.card h3 {
  font-size: 16px;
  font-weight: 500;
  margin: 0 0 16px;
}

/* Truncated cell */
.truncated-cell {
  font-size: 12px;
  color: var(--text-secondary);
}

/* Empty hint */
.empty-hint {
  text-align: center;
  padding: 24px 0;
  color: var(--text-secondary);
  font-size: 13px;
}

@media (max-width: 768px) {
  .metrics-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
  }

  .metric-value {
    font-size: 22px;
  }
}

@media (max-width: 480px) {
  .metrics-grid {
    grid-template-columns: 1fr;
  }
}
</style>
