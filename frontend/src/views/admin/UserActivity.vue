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
          <div v-if="!isMobile && data.topActiveUsers.length > 0">
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
          </div>
          <div v-if="isMobile && data.topActiveUsers.length > 0" class="mobile-card-list">
            <div v-for="user in data.topActiveUsers" :key="user.userId" class="mobile-card">
              <div class="mobile-card-row">
                <strong>{{ user.userId.substring(0, 8) }}</strong>
                <span>{{ user.requestCount }} 次请求</span>
              </div>
              <div class="mobile-card-meta">
                <span>{{ user.ip }}</span>
                <span>{{ formatDate(user.lastSeen) }}</span>
              </div>
            </div>
          </div>
          <div v-if="!data.topActiveUsers.length" class="empty-hint">暂无活跃用户数据</div>
        </div>
      </template>
      <!-- 加载失败：与"暂无数据"区分，提供重试（G14-14） -->
      <div v-else-if="!loading && errorShown" class="error-state">
        <p>加载用户活跃数据失败</p>
        <t-button variant="outline" size="small" @click="fetchData">重试</t-button>
      </div>
      <div v-else-if="!loading" class="empty-hint">暂无数据</div>
    </t-loading>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '@/stores/auth';
import MessagePlugin from '@/utils/message';
import { formatDate } from '@/utils/format';
import { useMobile } from '../../composables/useMobile';

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
const errorShown = ref(false); // 失败提示去重（G14-14）
const isMobile = useMobile();

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
    errorShown.value = false;
  } catch {
    data.value = null;
    // 失败需可见（G14-14）：避免静默降级为"暂无数据"造成虚假安心
    if (!errorShown.value) {
      errorShown.value = true;
      MessagePlugin.error('加载用户活跃数据失败');
    }
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

.toolbar {
  margin-bottom: 20px;
}

.truncated-cell {
  font-size: 12px;
  color: var(--text-secondary);
}

.error-state {
  text-align: center;
  padding: 32px 0;
  color: var(--color-danger);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.error-state p {
  margin: 0;
}
</style>
