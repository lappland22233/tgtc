<template>
  <div class="alerts-page">
    <div class="page-header">
      <h1>告警管理</h1>
      <p>查看和确认系统告警通知</p>
    </div>

    <!-- 统计卡片与操作 -->
    <div style="display: flex; gap: 16px; align-items: center; margin-bottom: 16px; flex-wrap: wrap;">
      <t-card style="flex: 0 0 auto; min-width: 200px;">
        <div style="text-align: center;">
          <div style="font-size: 14px; color: var(--text-secondary); margin-bottom: 8px;">未确认告警</div>
          <div
            :style="{ fontSize: '28px', fontWeight: '700', color: unacknowledgedCount > 5 ? 'var(--error)' : 'var(--warning)' }"
          >
            {{ unacknowledgedCount }}
          </div>
        </div>
      </t-card>
      <t-popconfirm content="确认所有未确认告警？" @confirm="handleAcknowledgeAll">
        <t-button theme="warning" :disabled="unacknowledgedCount === 0">一键确认全部</t-button>
      </t-popconfirm>
    </div>

    <!-- 过滤器 -->
    <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 16px; flex-wrap: wrap;">
      <t-select v-model="filterLevel" clearable placeholder="告警级别" style="width: 140px;" @change="fetchList(1)">
        <t-option value="info" label="信息" />
        <t-option value="warning" label="警告" />
        <t-option value="critical" label="严重" />
      </t-select>
      <t-select v-model="filterAcknowledged" placeholder="确认状态" style="width: 140px;" @change="fetchList(1)">
        <t-option :value="false" label="未确认" />
        <t-option :value="true" label="已确认" />
        <t-option :value="''" label="全部" />
      </t-select>
      <span style="font-size: 12px; color: var(--text-secondary);">共 {{ total }} 条</span>
    </div>

    <!-- 数据表格 -->
    <t-table
      :data="list"
      :columns="columns"
      row-key="id"
      :loading="loading"
      :pagination="false"
      stripe
    >
      <template #level="{ row }">
        <t-tag
          :theme="row.level === 'critical' ? 'danger' : row.level === 'warning' ? 'warning' : 'primary'"
          variant="light"
        >
          {{ levelLabel(row.level) }}
        </t-tag>
      </template>
      <template #ruleId="{ row }">
        {{ ruleMap[row.ruleId] || row.ruleId || '-' }}
      </template>
      <template #createdAt="{ row }">
        {{ formatDate(row.createdAt) }}
      </template>
      <template #acknowledgedAt="{ row }">
        {{ row.acknowledgedAt ? formatDate(row.acknowledgedAt) : '-' }}
      </template>
      <template #action="{ row }">
        <t-popconfirm v-if="!row.acknowledgedAt" content="确认该告警？" @confirm="handleAcknowledge(row.id)">
          <t-button size="small" variant="outline" theme="primary">确认</t-button>
        </t-popconfirm>
        <span v-else style="color: var(--text-secondary);">已确认</span>
      </template>
    </t-table>

    <!-- 分页 -->
    <div style="margin-top: 16px; display: flex; justify-content: flex-end;">
      <t-pagination
        v-model="currentPage"
        :total="total"
        :page-size="pageSize"
        :show-jumper="true"
        @change="fetchList"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '@/stores/auth';
import { formatDate } from '@/utils/format';

const ruleMap: Record<string, string> = {
  TRAFFIC_QPS: 'QPS偏高',
  TRAFFIC_QPS_CRIT: 'QPS严重偏高',
  TRAFFIC_BANDWIDTH: '带宽偏高',
  ERROR_5XX_RATE: '5xx错误率偏高',
  ERROR_5XX_SPIKE: '5xx错误激增',
  ERROR_404_SPIKE: '404错误激增',
  SEC_IP_FLOOD: '单IP高频访问',
  SEC_BRUTE_FORCE: '登录爆破',
  SEC_ABNORMAL_DOWNLOAD: '异常下载',
};

function levelLabel(l: string) {
  if (l === 'critical') return '严重';
  if (l === 'warning') return '警告';
  return '信息';
}

const columns = [
  { colKey: 'id', title: 'ID', width: 100, ellipsis: true },
  { colKey: 'ruleId', title: '告警规则', width: 140 },
  { colKey: 'level', title: '级别', width: 80 },
  { colKey: 'title', title: '标题', width: 180, ellipsis: true },
  { colKey: 'message', title: '详情', ellipsis: true },
  { colKey: 'createdAt', title: '触发时间', width: 160 },
  { colKey: 'acknowledgedAt', title: '确认时间', width: 160 },
  { colKey: 'action', title: '操作', width: 100 },
];

const list = ref<any[]>([]);
const total = ref(0);
const currentPage = ref(1);
const pageSize = 20;
const loading = ref(false);
const unacknowledgedCount = ref(0);
const filterLevel = ref('');
const filterAcknowledged = ref<boolean | ''>(false);

function buildParams(page: number): Record<string, string> {
  const p: Record<string, string> = { page: String(page), limit: String(pageSize) };
  if (filterLevel.value) p.level = filterLevel.value;
  if (filterAcknowledged.value !== '') p.acknowledged = String(filterAcknowledged.value);
  return p;
}

async function fetchList(page: number) {
  loading.value = true;
  try {
    const res = await api.get('/admin/alerts', { params: buildParams(page) });
    const data = res.data?.data || { items: [], total: 0 };
    list.value = data.items || [];
    total.value = data.total || 0;
    currentPage.value = page;
  } catch {
    /* ignore */
  } finally {
    loading.value = false;
  }
}

async function fetchUnacknowledgedCount() {
  try {
    const res = await api.get('/admin/alerts/unacknowledged');
    unacknowledgedCount.value = Array.isArray(res.data?.data) ? res.data.data.length : 0;
  } catch {
    /* ignore */
  }
}

async function handleAcknowledge(id: string) {
  try {
    await api.post(`/admin/alerts/${id}/acknowledge`);
    await Promise.all([fetchList(currentPage.value), fetchUnacknowledgedCount()]);
  } catch {
    /* ignore */
  }
}

async function handleAcknowledgeAll() {
  try {
    await api.post('/admin/alerts/acknowledge-all');
    await Promise.all([fetchList(1), fetchUnacknowledgedCount()]);
  } catch {
    /* ignore */
  }
}

onMounted(() => {
  fetchList(1);
  fetchUnacknowledgedCount();
});
</script>
