<template>
  <div class="telemetry-stats-page">
    <div class="page-header">
      <h1>遥测监控</h1>
      <p>前端错误、页面性能、设备环境等遥测数据统计与监控</p>
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <t-radio-group v-model="timeRange" variant="default-filled" @change="onTimeRangeChange">
          <t-radio-button value="1h">1小时</t-radio-button>
          <t-radio-button value="24h">24小时</t-radio-button>
          <t-radio-button value="7d">7天</t-radio-button>
          <t-radio-button value="30d">30天</t-radio-button>
        </t-radio-group>
        <span v-if="lastRefreshTime" style="font-size: 12px; color: var(--text-secondary); white-space: nowrap; margin-left: auto;">
          最后更新：{{ lastRefreshTime }}
        </span>
      </div>
    </div>

    <!-- 核心指标卡片 -->
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">总记录数</div>
        <div class="metric-value">{{ formatNumber(stats.totalRecords) }}</div>
        <div class="metric-sub">选定时间范围内</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">错误数</div>
        <div class="metric-value" :style="{ color: stats.byType.error > 0 ? 'var(--error)' : '' }">{{ formatNumber(stats.byType.error) }}</div>
        <div class="metric-sub">{{ errorRate }}% 错误率</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">性能记录</div>
        <div class="metric-value">{{ formatNumber(stats.byType.performance) }}</div>
        <div class="metric-sub">页面加载指标</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">独立设备</div>
        <div class="metric-value">{{ formatNumber(stats.uniqueIPs) }}</div>
        <div class="metric-sub">去重 IP 统计</div>
      </div>
    </div>

    <!-- 图表区域 -->
    <div class="charts-grid">
      <div class="card chart-card">
        <h3>上报趋势</h3>
        <div ref="trendChartRef" class="chart-container"></div>
      </div>
      <div class="card chart-card">
        <h3>类型分布</h3>
        <div ref="pieChartRef" class="chart-container"></div>
      </div>
    </div>

    <!-- 页面性能概览 -->
    <div class="card" style="margin-top: 16px;">
      <h3 style="margin-bottom: 12px;">页面性能概览 · 平均加载: {{ perfSummary.avgPageLoad }}ms · {{ perfSummary.totalPages }} 个页面</h3>
      <div ref="perfChartRef" class="chart-container" style="height: 360px;" v-show="perfPages.length > 0"></div>
      <div v-show="perfPages.length === 0" class="empty">暂无性能数据</div>
    </div>

    <!-- 最近错误 -->
    <div class="card" style="margin-top: 16px;">
      <h3 style="margin-bottom: 12px;">最近错误 ({{ errors.length }})</h3>
      <div v-if="errors.length === 0" class="empty">暂无错误记录</div>
      <t-table
        v-else
        :data="errors.slice(0, 10)"
        :columns="errorColumns"
        row-key="id"
        size="small"
        max-height="400"
        hover
      />
    </div>

    <!-- 数据导出 -->
    <div class="card" style="margin-top: 16px;">
      <h3 style="margin-bottom: 12px;">数据导出</h3>
      <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <t-date-picker v-model="exportStartDate" placeholder="开始日期" enable-time-picker style="width: 200px;" clearable />
        <span style="color: var(--text-secondary);">至</span>
        <t-date-picker v-model="exportEndDate" placeholder="结束日期" enable-time-picker style="width: 200px;" clearable />
        <t-select v-model="exportType" placeholder="类型筛选" clearable style="width: 140px;">
          <t-option value="" label="全部类型" />
          <t-option value="error" label="错误" />
          <t-option value="performance" label="性能" />
          <t-option value="environment" label="环境" />
        </t-select>
        <t-button theme="primary" @click="handleExport" :loading="exporting">
          📥 导出 JSON
        </t-button>
        <span v-if="exportResult" style="font-size: 12px; color: var(--success);">
          {{ exportResult }}
        </span>
      </div>
    </div>

    <!-- 遥测记录列表 -->
    <div class="card" style="margin-top: 16px;">
      <h3 style="margin-bottom: 12px;">遥测记录</h3>
      <div style="margin-bottom: 12px; display: flex; gap: 12px; align-items: center;">
        <t-select v-model="typeFilter" placeholder="全部类型" clearable style="width: 150px;" @change="fetchRecords">
          <t-option value="" label="全部类型" />
          <t-option value="error" label="错误" />
          <t-option value="performance" label="性能" />
          <t-option value="environment" label="环境" />
        </t-select>
        <t-button variant="text" @click="fetchRecords">刷新</t-button>
      </div>
      <t-table
        :data="records"
        :columns="recordColumns"
        :pagination="pagination"
        row-key="id"
        size="small"
        hover
        @page-change="onPageChange"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, nextTick } from 'vue';
import * as echarts from 'echarts';
import client from '../../api/client';
import { CHART_COLORS, tooltipBase, legendBase, areaGradient } from '../../utils/echarts-theme';

// ---- 时间范围 ----
const timeRange = ref('24h');
const lastRefreshTime = ref('');

// ---- 统计 ----
interface Stats {
  totalRecords: number;
  byType: { error: number; performance: number; environment: number };
  uniqueIPs: number;
  trend: { time: string; error: number; performance: number; environment: number }[];
}
const stats = reactive<Stats>({
  totalRecords: 0,
  byType: { error: 0, performance: 0, environment: 0 },
  uniqueIPs: 0,
  trend: [],
});

const errorRate = computed(() => {
  if (stats.totalRecords === 0) return '0.0';
  return ((stats.byType.error / stats.totalRecords) * 100).toFixed(1);
});

// ---- 记录列表 ----
interface RecordItem {
  id: string;
  type: string;
  data: Record<string, any>;
  ip: string;
  userAgent: string | null;
  clientTimestamp: number | null;
  createdAt: string;
}
const records = ref<RecordItem[]>([]);
const typeFilter = ref('');
const pagination = reactive({ current: 1, pageSize: 20, total: 0, showJumper: true });

// ---- 错误列表 ----
const errors = ref<RecordItem[]>([]);

// ---- 导出 ----
const exportStartDate = ref('');
const exportEndDate = ref('');
const exportType = ref('');
const exporting = ref(false);
const exportResult = ref('');

// ---- 性能概览 ----
interface PerfPage { url: string; count: number; dns: number; tcp: number; ttfb: number; domReady: number; pageLoad: number; fcp: number; }
const perfPages = ref<PerfPage[]>([]);
const perfSummary = reactive({ avgPageLoad: 0, totalPages: 0, totalSamples: 0 });

// ---- 表格列 ----
const errorColumns = [
  { colKey: 'createdAt', title: '时间', width: 160, cell: (_h: any, { row }: any) => formatTime(row.createdAt) },
  { colKey: 'data.message', title: '消息', ellipsis: true },
  { colKey: 'data.tag', title: '标签', width: 120 },
  { colKey: 'ip', title: 'IP', width: 140 },
];
const recordColumns = [
  { colKey: 'createdAt', title: '时间', width: 160, cell: (_h: any, { row }: any) => formatTime(row.createdAt) },
  { colKey: 'type', title: '类型', width: 100, cell: (_h: any, { row }: any) => typeBadge(row.type) },
  { colKey: 'ip', title: 'IP', width: 140 },
  { colKey: 'userAgent', title: 'User-Agent', ellipsis: true, width: 200 },
  { colKey: 'data', title: '数据摘要', ellipsis: true, cell: (_h: any, { row }: any) => formatDataSummary(row.type, row.data) },
];

function typeBadge(type: string): string {
  const map: Record<string, string> = { error: '错误', performance: '性能', environment: '环境' };
  return map[type] || type;
}

function formatDataSummary(type: string, data: Record<string, any>): string {
  if (type === 'error') return `消息: ${data?.message || '-'} · 标签: ${data?.tag || '-'}`;
  if (type === 'performance') return `页面加载: ${data?.pageLoad || '-'}ms · URL: ${data?.url || '-'}`;
  if (type === 'environment') return `屏幕: ${data?.screen || '-'} · 视口: ${data?.viewport || '-'} · 平台: ${data?.platform || '-'}`;
  return '-';
}

// ---- 格式化 ----
function formatNumber(n: number | undefined): string {
  if (n == null || n === 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function formatTime(t: string): string {
  if (!t) return '-';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---- API 请求 ----
async function fetchStats() {
  try {
    const res = await client.get('/admin/telemetry/stats', { params: { timeRange: timeRange.value } });
    // NestJS 全局拦截器包装: { code, message, data: <service-return> }
    Object.assign(stats, res.data.data || res.data);
    await nextTick();
    updateTrendChart();
    updatePieChart();
  } catch (e) {
    console.error('获取遥测统计失败:', e);
  }
}

async function fetchRecords() {
  try {
    const res = await client.get('/admin/telemetry/records', {
      params: {
        page: pagination.current,
        limit: pagination.pageSize,
        type: typeFilter.value || undefined,
        timeRange: timeRange.value,
      },
    });
    const body = res.data.data || res.data;
    records.value = body.items || [];
    pagination.total = body.total || 0;
  } catch (e) {
    console.error('获取遥测记录失败:', e);
  }
}

async function fetchErrors() {
  try {
    const res = await client.get('/admin/telemetry/errors', { params: { limit: 50 } });
    errors.value = (res.data.data || res.data) || [];
  } catch (e) {
    console.error('获取错误列表失败:', e);
  }
}

async function refreshAll() {
  await Promise.all([fetchStats(), fetchRecords(), fetchErrors(), fetchPerformance()]);
  lastRefreshTime.value = new Date().toLocaleTimeString();
}

function onTimeRangeChange() {
  pagination.current = 1;
  refreshAll();
}

function onPageChange(pageInfo: { current: number; pageSize: number }) {
  pagination.current = pageInfo.current;
  pagination.pageSize = pageInfo.pageSize;
  fetchRecords();
}

async function handleExport() {
  if (exporting.value) return;
  exporting.value = true;
  exportResult.value = '';

  try {
    const params: Record<string, string> = {};
    if (exportStartDate.value) params.startDate = exportStartDate.value;
    if (exportEndDate.value) params.endDate = exportEndDate.value;
    if (exportType.value) params.type = exportType.value;

    const res = await client.get('/admin/telemetry/export', {
      params,
      responseType: 'blob',
    });

    // 触发浏览器下载
    const url = window.URL.createObjectURL(new Blob([res.data]));
    const a = document.createElement('a');
    a.href = url;
    a.download = `telemetry-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

    exportResult.value = '导出成功';
    setTimeout(() => { exportResult.value = ''; }, 3000);
  } catch (e) {
    exportResult.value = '导出失败';
    console.error('导出失败:', e);
  } finally {
    exporting.value = false;
  }
}

// ---- ECharts ----
const trendChartRef = ref<HTMLDivElement | null>(null);
const pieChartRef = ref<HTMLDivElement | null>(null);
const perfChartRef = ref<HTMLDivElement | null>(null);
let trendChart: echarts.ECharts | null = null;
let pieChart: echarts.ECharts | null = null;
let perfChart: echarts.ECharts | null = null;
let resizeObserver: ResizeObserver | null = null;

function initCharts() {
  if (trendChartRef.value) trendChart = echarts.init(trendChartRef.value, 'cyber');
  if (pieChartRef.value) pieChart = echarts.init(pieChartRef.value, 'cyber');
  if (perfChartRef.value) perfChart = echarts.init(perfChartRef.value, 'cyber');
}

function updateTrendChart() {
  if (!trendChart) return;
  const times = stats.trend.map(t => {
    const d = new Date(t.time);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  });

  trendChart.setOption({
    tooltip: { trigger: 'axis', ...tooltipBase },
    legend: { data: ['错误', '性能', '环境'], ...legendBase },
    grid: { left: 50, right: 20, top: 30, bottom: 30 },
    xAxis: { type: 'category', data: times, axisLabel: { color: '#8895A7', fontSize: 11 } },
    yAxis: { type: 'value', axisLabel: { color: '#8895A7', fontSize: 11 } },
    series: [
      { name: '错误', type: 'line', data: stats.trend.map(t => t.error), smooth: true, lineStyle: { color: CHART_COLORS.danger, width: 2 }, itemStyle: { color: CHART_COLORS.danger }, areaStyle: { color: areaGradient(CHART_COLORS.danger) }, symbol: 'none' },
      { name: '性能', type: 'line', data: stats.trend.map(t => t.performance), smooth: true, lineStyle: { color: CHART_COLORS.success, width: 2 }, itemStyle: { color: CHART_COLORS.success }, areaStyle: { color: areaGradient(CHART_COLORS.success) }, symbol: 'none' },
      { name: '环境', type: 'line', data: stats.trend.map(t => t.environment), smooth: true, lineStyle: { color: CHART_COLORS.info, width: 2 }, itemStyle: { color: CHART_COLORS.info }, areaStyle: { color: areaGradient(CHART_COLORS.info) }, symbol: 'none' },
    ],
  });
}

function updatePieChart() {
  if (!pieChart) return;
  pieChart.setOption({
    tooltip: { trigger: 'item', ...tooltipBase },
    legend: { orient: 'vertical', left: 10, ...legendBase },
    series: [{
      type: 'pie',
      radius: ['45%', '75%'],
      center: ['60%', '50%'],
      label: { color: '#8895A7' },
      emphasis: { itemStyle: { shadowBlur: 20, shadowColor: 'rgba(0,0,0,0.4)' } },
      data: [
        { name: '错误', value: stats.byType.error, itemStyle: { color: CHART_COLORS.danger } },
        { name: '性能', value: stats.byType.performance, itemStyle: { color: CHART_COLORS.success } },
        { name: '环境', value: stats.byType.environment, itemStyle: { color: CHART_COLORS.info } },
      ],
    }],
  });
}

function updatePerfChart() {
  if (!perfChart || perfPages.value.length === 0) return;
  const top10 = perfPages.value.slice(0, 10);
  const labels = top10.map(p => {
    try { const u = new URL(p.url, location.origin); return u.pathname || '/'; } catch { return p.url; }
  });

  const stages = [
    { name: 'DNS', key: 'dns', color: CHART_COLORS.slate },
    { name: 'TCP', key: 'tcp', color: CHART_COLORS.indigo },
    { name: 'TTFB', key: 'ttfb', color: CHART_COLORS.warning },
    { name: 'DOM Ready', key: 'domReady', color: CHART_COLORS.amber },
    { name: 'Page Load', key: 'pageLoad', color: CHART_COLORS.success },
    { name: 'FCP', key: 'fcp', color: CHART_COLORS.violet },
  ];

  perfChart.setOption({
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...tooltipBase,
      formatter: (params: any) => {
        const idx = params[0].dataIndex;
        const p = top10[idx];
        return `<b>${p.url}</b><br/>` +
          params.map((s: any) => `${s.marker} ${s.seriesName}: ${s.value}ms`).join('<br/>') +
          `<br/>总计: ${p.pageLoad}ms · 样本: ${p.count}`;
      },
    },
    legend: { data: stages.map(s => s.name), ...legendBase, bottom: 0 },
    grid: { left: 110, right: 40, top: 10, bottom: 40 },
    xAxis: { type: 'value', name: 'ms', nameTextStyle: { color: '#8895A7', fontSize: 11 }, axisLabel: { color: '#8895A7', fontSize: 11 } },
    yAxis: { type: 'category', data: labels.reverse(), axisLabel: { color: '#8895A7', fontSize: 11, width: 100, overflow: 'truncate' } },
    series: stages.map(stage => ({
      name: stage.name,
      type: 'bar',
      stack: 'total',
      emphasis: { focus: 'series' },
      itemStyle: { color: stage.color },
      data: top10.map(p => (p as any)[stage.key] || 0).reverse(),
    })),
  });
}

async function fetchPerformance() {
  try {
    const res = await client.get('/admin/telemetry/performance', { params: { timeRange: timeRange.value } });
    const body = res.data.data || res.data;
    perfPages.value = body.pages || [];
    Object.assign(perfSummary, body.summary || {});
    await nextTick();
    perfChart?.resize();
    updatePerfChart();
  } catch (e) {
    console.error('获取性能概览失败:', e);
  }
}

// ---- 生命周期 ----
onMounted(async () => {
  initCharts();
  await refreshAll();
  // ResizeObserver: 容器实际尺寸变化时才 resize（比 window.resize 更精准）
  resizeObserver = new ResizeObserver(() => {
    trendChart?.resize();
    pieChart?.resize();
    perfChart?.resize();
  });
  if (trendChartRef.value) resizeObserver.observe(trendChartRef.value);
  if (pieChartRef.value) resizeObserver.observe(pieChartRef.value);
  if (perfChartRef.value) resizeObserver.observe(perfChartRef.value);
});

onUnmounted(() => {
  trendChart?.dispose();
  pieChart?.dispose();
  perfChart?.dispose();
  resizeObserver?.disconnect();
});
</script>

<style scoped>
.telemetry-stats-page {
  padding: 20px;
  max-width: 1400px;
  margin: 0 auto;
}
.page-header {
  margin-bottom: 20px;
}
.page-header h1 {
  font-size: 24px;
  margin: 0 0 4px;
}
.page-header p {
  color: var(--text-secondary);
  margin: 0;
  font-size: 14px;
}
.toolbar {
  margin-bottom: 16px;
  padding: 12px;
  background: var(--bg-secondary);
  border-radius: 8px;
}
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}
.metric-card {
  background: var(--bg-secondary);
  border-radius: 8px;
  padding: 16px;
}
.metric-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}
.metric-value {
  font-size: 28px;
  font-weight: bold;
}
.metric-sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
}
.charts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.chart-card {
  padding: 16px;
}
.chart-card h3 {
  margin: 0 0 12px;
  font-size: 14px;
}
.chart-container {
  height: 300px;
  width: 100%;
}
.card {
  background: var(--bg-secondary);
  border-radius: 8px;
  padding: 16px;
}
.card h3 {
  margin: 0;
  font-size: 14px;
}
.empty {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary);
}

/* 响应式：窄屏自动降级列数 */
@media (max-width: 900px) {
  .metrics-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .charts-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 500px) {
  .metrics-grid {
    grid-template-columns: 1fr;
  }
  .metric-value {
    font-size: 22px;
  }
  .chart-container {
    height: 240px;
  }
}
</style>
