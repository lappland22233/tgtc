<template>
  <div class="access-logs-page">
    <div class="page-header">
      <h1>访问统计</h1>
      <p>网站请求量、带宽消耗、独立访客与流量峰值监控</p>
    </div>

    <!-- 时间范围选择器 -->
    <div class="toolbar">
      <t-radio-group v-model="timeRange" variant="default-filled" @change="onTimeRangeChange">
        <t-radio-button value="1h">1小时</t-radio-button>
        <t-radio-button value="24h">24小时</t-radio-button>
        <t-radio-button value="7d">7天</t-radio-button>
        <t-radio-button value="30d">30天</t-radio-button>
      </t-radio-group>
    </div>

    <!-- 核心指标卡片 -->
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">总请求数</div>
        <div class="metric-value">{{ formatNumber(stats.totalRequests) }}</div>
        <div class="metric-sub">选定时间范围内</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">带宽消耗</div>
        <div class="metric-value">{{ formatSize(stats.totalBandwidth) }}</div>
        <div class="metric-sub">累计数据传输</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">独立访客</div>
        <div class="metric-value">{{ formatNumber(stats.uniqueVisitors) }}</div>
        <div class="metric-sub">去重 IP 统计</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">峰值 QPS</div>
        <div class="metric-value">{{ formatNumber(stats.peakQPS) }}/s</div>
        <div class="metric-sub">分钟级峰值</div>
      </div>
      <div class="metric-card error-card" v-if="stats.errorRate > 0">
        <div class="metric-label">错误率</div>
        <div class="metric-value" style="color: var(--error);">{{ stats.errorRate }}%</div>
        <div class="metric-sub">4xx/5xx 占比</div>
      </div>
    </div>

    <!-- 图表区域 -->
    <div class="charts-grid">
      <div class="card chart-card">
        <h3>流量趋势</h3>
        <div ref="trendChartRef" class="chart-container"></div>
      </div>
      <div class="card chart-card">
        <h3>状态码分布</h3>
        <div ref="pieChartRef" class="chart-container"></div>
      </div>
    </div>

    <!-- 访问记录表格 -->
    <div class="card">
      <h3 style="margin-bottom: 16px;">访问记录</h3>

      <div class="table-filters">
        <t-input
          v-model="filterPath"
          placeholder="搜索请求路径..."
          clearable
          style="width: 260px;"
          @enter="onFilterChange"
          @clear="onFilterChange"
        />
        <t-select
          v-model="filterStatus"
          placeholder="状态码"
          clearable
          style="width: 140px;"
          @change="onFilterChange"
        >
          <t-option :value="undefined" label="全部" />
          <t-option value="200" label="200 OK" />
          <t-option value="301" label="301 Moved" />
          <t-option value="302" label="302 Found" />
          <t-option value="304" label="304 Not Modified" />
          <t-option value="400" label="400 Bad Request" />
          <t-option value="401" label="401 Unauthorized" />
          <t-option value="403" label="403 Forbidden" />
          <t-option value="404" label="404 Not Found" />
          <t-option value="500" label="500 Server Error" />
        </t-select>
        <t-button variant="outline" @click="onRefresh">刷新</t-button>
      </div>

      <t-table
        :data="logs"
        :columns="columns"
        :loading="loading"
        :pagination="pagination"
        row-key="id"
        table-layout="auto"
        @page-change="onPageChange"
      >
        <template #statusCode="{ row }">
          <t-tag :theme="statusTheme(row.statusCode)" variant="light" size="small">
            {{ row.statusCode }}
          </t-tag>
        </template>
        <template #method="{ row }">
          <t-tag :theme="methodTheme(row.method)" variant="outline" size="small">
            {{ row.method }}
          </t-tag>
        </template>
        <template #duration="{ row }">
          {{ row.duration }}ms
        </template>
        <template #responseSize="{ row }">
          {{ formatSize(row.responseSize) }}
        </template>
        <template #createdAt="{ row }">
          {{ formatTime(row.createdAt) }}
        </template>
      </t-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import * as echarts from 'echarts';
import client from '../../api/client';

// Types
interface AccessLogItem {
  id: string;
  ip: string;
  method: string;
  path: string;
  statusCode: number;
  responseSize: number;
  duration: number;
  userAgent: string | null;
  createdAt: string;
}

interface Stats {
  totalRequests: number;
  totalBandwidth: number;
  uniqueVisitors: number;
  peakQPS: number;
  errorRate: number;
  statusDistribution: { statusCode: number; count: number }[];
}

interface TrendItem {
  time: string;
  requests: number;
  bandwidth: number;
}

// State
const timeRange = ref('24h');
const filterPath = ref('');
const filterStatus = ref<number | undefined>(undefined);
const loading = ref(false);
const stats = reactive<Stats>({
  totalRequests: 0,
  totalBandwidth: 0,
  uniqueVisitors: 0,
  peakQPS: 0,
  errorRate: 0,
  statusDistribution: [],
});
const logs = ref<AccessLogItem[]>([]);
const total = ref(0);
const currentPage = ref(1);
const pageSize = ref(20);

const pagination = reactive({
  current: 1,
  pageSize: 20,
  total: 0,
  showJumper: true,
  pageSizeOptions: [10, 20, 50],
});

// Charts
const trendChartRef = ref<HTMLDivElement | null>(null);
const pieChartRef = ref<HTMLDivElement | null>(null);
let trendChart: echarts.ECharts | null = null;
let pieChart: echarts.ECharts | null = null;

// Table columns (mobile-friendly responsive)
const columns = [
  { colKey: 'ip', title: 'IP 地址', width: 140 },
  { colKey: 'method', title: '方法', width: 70 },
  { colKey: 'path', title: '请求路径', ellipsis: true, minWidth: 160 },
  { colKey: 'statusCode', title: '状态码', width: 90 },
  { colKey: 'duration', title: '耗时', width: 80 },
  { colKey: 'responseSize', title: '流量', width: 90 },
  { colKey: 'createdAt', title: '时间', width: 170 },
];

// Status code tag theme
function statusTheme(code: number): string {
  if (code < 300) return 'success';
  if (code < 400) return 'warning';
  return 'danger';
}

// HTTP method tag theme
function methodTheme(method: string): string {
  const map: Record<string, string> = { GET: 'success', POST: 'primary', PUT: 'warning', DELETE: 'danger', PATCH: 'default' };
  return map[method] || 'default';
}

// Format numbers
function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

// Format size
function formatSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(2) + ' GB';
  if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' MB';
  if (bytes >= 1_024) return (bytes / 1_024).toFixed(1) + ' KB';
  return bytes + ' B';
}

// Format time
function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Fetch stats
async function fetchStats() {
  try {
    const { data } = await client.get('/admin/access-logs/stats', { params: { timeRange: timeRange.value } });
    const d = data.data || data;
    Object.assign(stats, d);
    updatePieChart();
  } catch {
    // Stats error handled silently
  }
}

// Fetch trend
async function fetchTrend() {
  try {
    const { data } = await client.get('/admin/access-logs/trend', { params: { timeRange: timeRange.value } });
    const trendData = (data.data || data) as TrendItem[];
    updateTrendChart(trendData);
  } catch {
    // Trend error handled silently
  }
}

// Fetch logs
async function fetchLogs() {
  loading.value = true;
  try {
    const params: Record<string, unknown> = {
      page: currentPage.value,
      limit: pageSize.value,
      timeRange: timeRange.value,
    };
    if (filterPath.value) params.path = filterPath.value;
    if (filterStatus.value) params.statusCode = filterStatus.value;

    const { data } = await client.get('/admin/access-logs', { params });
    const d = data.data || data;
    logs.value = d.items || [];
    total.value = d.total || 0;
    pagination.total = d.total || 0;
    pagination.current = currentPage.value;
    pagination.pageSize = pageSize.value;
  } catch {
    MessagePlugin.error('加载访问记录失败');
  } finally {
    loading.value = false;
  }
}

// Trend chart
function updateTrendChart(trendData: TrendItem[]) {
  if (!trendChartRef.value) return;

  if (!trendChart) {
    trendChart = echarts.init(trendChartRef.value, 'dark');
  }

  const times = trendData.map((t) => {
    const d = new Date(t.time);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  });

  trendChart.setOption({
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(30,30,30,0.9)',
      borderColor: '#444',
      textStyle: { color: '#eee', fontSize: 12 },
    },
    legend: {
      data: ['请求数', '带宽'],
      textStyle: { color: '#aaa' },
      top: 0,
    },
    grid: { left: 50, right: 60, top: 30, bottom: 30 },
    xAxis: {
      type: 'category',
      data: times,
      axisLabel: { color: '#888', fontSize: 10, rotate: trendData.length > 24 ? 45 : 0 },
      axisLine: { lineStyle: { color: '#444' } },
    },
    yAxis: [
      {
        type: 'value',
        name: '请求数',
        nameTextStyle: { color: '#888' },
        axisLabel: { color: '#888' },
        splitLine: { lineStyle: { color: '#333' } },
      },
      {
        type: 'value',
        name: '带宽',
        nameTextStyle: { color: '#888' },
        axisLabel: { color: '#888', formatter: (v: number) => formatSize(v) },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '请求数',
        type: 'line',
        data: trendData.map((t) => t.requests),
        smooth: true,
        symbol: 'none',
        lineStyle: { color: '#0052d9', width: 2 },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(0,82,217,0.3)' },
          { offset: 1, color: 'rgba(0,82,217,0.02)' },
        ])},
      },
      {
        name: '带宽',
        type: 'line',
        yAxisIndex: 1,
        data: trendData.map((t) => t.bandwidth),
        smooth: true,
        symbol: 'none',
        lineStyle: { color: '#2ba471', width: 2 },
      },
    ],
  });
}

// Pie chart
function updatePieChart() {
  if (!pieChartRef.value) return;

  if (!pieChart) {
    pieChart = echarts.init(pieChartRef.value, 'dark');
  }

  const dist = stats.statusDistribution || [];
  const pieData = dist.map((s) => ({
    name: s.statusCode.toString(),
    value: s.count,
    itemStyle: {
      color: s.statusCode < 300 ? '#2ba471' : s.statusCode < 400 ? '#e37318' : s.statusCode < 500 ? '#e34d59' : '#8b0000',
    },
  }));

  pieChart.setOption({
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(30,30,30,0.9)',
      borderColor: '#444',
      textStyle: { color: '#eee' },
      formatter: '{b}: {c} ({d}%)',
    },
    legend: {
      orient: 'vertical',
      right: 10,
      top: 'center',
      textStyle: { color: '#aaa', fontSize: 11 },
    },
    series: [
      {
        type: 'pie',
        radius: ['45%', '75%'],
        center: ['40%', '50%'],
        data: pieData.length > 0 ? pieData : [{ name: '无数据', value: 1, itemStyle: { color: '#444' } }],
        label: { show: false },
        emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
      },
    ],
  });
}

// Event handlers
function onTimeRangeChange() {
  currentPage.value = 1;
  refreshAll();
}

function onFilterChange() {
  currentPage.value = 1;
  fetchLogs();
}

function onPageChange(pageInfo: { current: number; pageSize: number }) {
  currentPage.value = pageInfo.current;
  pageSize.value = pageInfo.pageSize;
  fetchLogs();
}

function onRefresh() {
  refreshAll();
}

function refreshAll() {
  fetchStats();
  fetchTrend();
  fetchLogs();
}

// Lifecycle
onMounted(() => {
  refreshAll();
});

onUnmounted(() => {
  trendChart?.dispose();
  pieChart?.dispose();
});
</script>

<style scoped>
.access-logs-page {
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

.metric-sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
}

/* Charts grid */
.charts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  margin-bottom: 20px;
}

.chart-card {
  min-height: 360px;
}

.chart-card h3 {
  margin: 0 0 12px;
}

.chart-container {
  width: 100%;
  height: 320px;
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
}

/* Table filters */
.table-filters {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

/* Responsive */
@media (max-width: 768px) {
  .charts-grid {
    grid-template-columns: 1fr;
  }

  .metrics-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
  }

  .metric-value {
    font-size: 22px;
  }

  .chart-container {
    height: 240px;
  }

  .table-filters {
    flex-direction: column;
  }

  .table-filters > * {
    width: 100% !important;
  }
}

@media (max-width: 480px) {
  .metrics-grid {
    grid-template-columns: 1fr;
  }
}
</style>
