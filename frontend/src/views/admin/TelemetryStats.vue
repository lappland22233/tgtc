<template>
  <div class="telemetry-page">
    <!-- 页头：标题 + 全局控制 -->
    <div class="page-head">
      <div class="head-title">
        <h1>遥测监控</h1>
        <p>前端错误、页面性能与设备环境的统计与诊断</p>
      </div>
      <div class="head-actions">
        <t-radio-group v-model="timeRange" variant="default-filled" size="small" @change="onTimeRangeChange">
          <t-radio-button value="1h">1小时</t-radio-button>
          <t-radio-button value="24h">24小时</t-radio-button>
          <t-radio-button value="7d">7天</t-radio-button>
          <t-radio-button value="30d">30天</t-radio-button>
        </t-radio-group>

        <t-select
          v-model="autoRefreshInterval"
          size="small"
          style="width: 132px;"
          :options="autoRefreshOptions"
          @change="onAutoRefreshChange"
        />

        <t-button size="small" :loading="refreshing" @click="refreshAll">
          <template #icon><span class="btn-icon">⟳</span></template>
          刷新
        </t-button>
      </div>
    </div>

    <p v-if="lastRefreshTime" class="last-update">最后更新：{{ lastRefreshTime }}</p>

    <!-- 核心指标卡片（可点击筛选记录） -->
    <div class="metrics">
      <div class="metric-card" :class="{ active: typeFilter === '' }" @click="filterByType('')">
        <div class="metric-label">总记录数</div>
        <div class="metric-value">{{ formatNumber(stats.totalRecords) }}</div>
        <div class="metric-sub">选定时间范围内 · 点击查看全部</div>
      </div>
      <div class="metric-card metric-danger" :class="{ active: typeFilter === 'error' }" @click="filterByType('error')">
        <div class="metric-label">错误数</div>
        <div class="metric-value" :class="{ 'has-value': stats.byType.error > 0 }">{{ formatNumber(stats.byType.error) }}</div>
        <div class="metric-sub">{{ errorRate }}% 错误率</div>
      </div>
      <div class="metric-card metric-success" :class="{ active: typeFilter === 'performance' }" @click="filterByType('performance')">
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
    <div class="charts">
      <div class="card chart-card chart-trend">
        <div class="card-head"><h3>上报趋势</h3></div>
        <div ref="trendChartRef" class="chart-box"></div>
      </div>
      <div class="card chart-card chart-pie">
        <div class="card-head"><h3>类型分布</h3></div>
        <div ref="pieChartRef" class="chart-box"></div>
      </div>
    </div>

    <!-- 页面性能概览 -->
    <div class="card section">
      <div class="card-head">
        <h3>页面性能概览</h3>
        <div class="perf-summary" v-if="perfPages.length > 0">
          <span class="chip">平均加载 <b>{{ perfSummary.avgPageLoad }}ms</b></span>
          <span class="chip">{{ perfSummary.totalPages }} 个页面</span>
          <span class="chip">{{ perfSummary.totalSamples }} 个样本</span>
        </div>
      </div>
      <div ref="perfChartRef" class="chart-box chart-perf" v-show="perfPages.length > 0"></div>
      <div v-show="perfPages.length === 0" class="empty">暂无性能数据</div>
    </div>

    <!-- 最近错误 -->
    <div class="card section">
      <div class="card-head">
        <h3>最近错误</h3>
        <span class="count-badge" v-if="errors.length > 0">{{ errors.length }}</span>
      </div>
      <div v-if="errors.length === 0" class="empty">暂无错误记录 🎉</div>
      <t-table
        v-else
        :data="errorsTop"
        :columns="errorColumns"
        row-key="id"
        size="small"
        max-height="420"
        hover
        @row-click="({ row }: any) => openDetail(row)"
      />
    </div>

    <!-- 遥测记录列表 -->
    <div class="card section">
      <div class="card-head">
        <h3>遥测记录</h3>
        <div class="record-tools">
          <t-select
            v-model="typeFilter"
            placeholder="全部类型"
            clearable
            size="small"
            style="width: 130px;"
            @change="onTypeFilterChange"
          >
            <t-option value="" label="全部类型" />
            <t-option value="error" label="错误" />
            <t-option value="performance" label="性能" />
            <t-option value="environment" label="环境" />
          </t-select>
        </div>
      </div>
      <t-table
        :data="records"
        :columns="recordColumns"
        :pagination="pagination"
        :loading="recordsLoading"
        row-key="id"
        size="small"
        hover
        @page-change="onPageChange"
        @row-click="({ row }: any) => openDetail(row)"
      />
    </div>

    <!-- 记录详情抽屉 -->
    <t-drawer
      v-model:visible="detailVisible"
      :header="detailTitle"
      size="520px"
      placement="right"
      :footer="false"
    >
      <div v-if="detailRecord" class="detail-body">
        <div class="detail-grid">
          <div class="detail-item"><span class="d-label">类型</span><span class="d-value">{{ typeBadge(detailRecord.type) }}</span></div>
          <div class="detail-item"><span class="d-label">时间</span><span class="d-value">{{ formatFullTime(detailRecord.createdAt) }}</span></div>
          <div class="detail-item"><span class="d-label">IP</span><span class="d-value">{{ detailRecord.ip || '-' }}</span></div>
          <div class="detail-item"><span class="d-label">客户端时间</span><span class="d-value">{{ detailRecord.clientTimestamp ? formatFullTime(new Date(detailRecord.clientTimestamp).toISOString()) : '-' }}</span></div>
          <div class="detail-item full"><span class="d-label">User-Agent</span><span class="d-value mono wrap">{{ detailRecord.userAgent || '-' }}</span></div>
        </div>
        <div class="detail-data">
          <div class="d-label">数据载荷</div>
          <pre class="json-block">{{ formatJson(detailRecord.data) }}</pre>
        </div>
      </div>
    </t-drawer>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, nextTick, h } from 'vue';
import * as echarts from '@/utils/echarts';
import client from '../../api/client';
import { CHART_COLORS, tooltipBase, legendBase, areaGradient, ensureCyberTheme } from '../../utils/echarts-theme';

// Theme-aware chart colors
const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';
const axisLabelColor = () => isDark() ? '#8895A7' : '#5F6B7A';

// ---- 时间范围 ----
const timeRange = ref('24h');
const lastRefreshTime = ref('');
const refreshing = ref(false);

// ---- 自动刷新 ----
const autoRefreshInterval = ref(0); // 0 = 关闭，单位秒
const autoRefreshOptions = [
  { label: '自动刷新：关', value: 0 },
  { label: '每 30 秒', value: 30 },
  { label: '每 1 分钟', value: 60 },
  { label: '每 5 分钟', value: 300 },
];
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

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
const recordsLoading = ref(false);
const typeFilter = ref('');
const pagination = reactive({ current: 1, pageSize: 20, total: 0, showJumper: true });

// ---- 错误列表 ----
const errors = ref<RecordItem[]>([]);
// 稳定的前 10 条引用：避免在模板里 errors.slice(0,10) 每次渲染都产生新数组，
// 导致 t-table 频繁全量重渲染（放大 TDesign 单元格生命周期竞态、影响性能）。
const errorsTop = computed(() => errors.value.slice(0, 10));

// ---- 详情抽屉 ----
const detailVisible = ref(false);
const detailRecord = ref<RecordItem | null>(null);
const detailTitle = computed(() =>
  detailRecord.value ? typeBadge(detailRecord.value.type) + '详情' : '记录详情',
);

// ---- 性能概览 ----
interface PerfPage { url: string; count: number; dns: number; tcp: number; ttfb: number; domReady: number; pageLoad: number; fcp: number; }
const perfPages = ref<PerfPage[]>([]);
const perfSummary = reactive({ avgPageLoad: 0, totalPages: 0, totalSamples: 0 });

// ---- 竞态防护：代际计数 + AbortController ----
let statsGen = 0;
let recordsGen = 0;
let recordsAbort: AbortController | null = null;

// 自定义省略号单元格：规避 TDesign TEllipsis 组件在 onMounted/onUpdated 中
// 调用 isTextEllipsis(root.value) 未判空触发的崩溃
//（"Cannot read properties of null (reading 'clientWidth')"）。
// 用原生 title 提供完整内容悬浮提示 + CSS 截断，行为等价且稳定。
function ellipsisCell(text: string) {
  return h('div', { class: 'cell-ellipsis', title: text }, text);
}

// ---- 表格列 ----
const errorColumns = [
  { colKey: 'createdAt', title: '时间', width: 150, cell: (_h: unknown, ctx: { row: RecordItem }) => formatTime(ctx.row.createdAt) },
  { colKey: 'data.message', title: '消息', cell: (_h: unknown, ctx: { row: RecordItem }) => ellipsisCell(ctx.row.data?.message || '-') },
  { colKey: 'data.tag', title: '标签', width: 120, cell: (_h: unknown, ctx: { row: RecordItem }) => ctx.row.data?.tag || '-' },
  { colKey: 'ip', title: 'IP', width: 130 },
];
const recordColumns = [
  { colKey: 'createdAt', title: '时间', width: 150, cell: (_h: unknown, ctx: { row: RecordItem }) => formatTime(ctx.row.createdAt) },
  { colKey: 'type', title: '类型', width: 90, cell: (_h: unknown, ctx: { row: RecordItem }) => typeBadge(ctx.row.type) },
  { colKey: 'ip', title: 'IP', width: 130 },
  { colKey: 'userAgent', title: 'User-Agent', width: 200, cell: (_h: unknown, ctx: { row: RecordItem }) => ellipsisCell(ctx.row.userAgent || '-') },
  { colKey: 'data', title: '数据摘要', cell: (_h: unknown, ctx: { row: RecordItem }) => ellipsisCell(formatDataSummary(ctx.row.type, ctx.row.data)) },
];

function typeBadge(type: string): string {
  const map: Record<string, string> = { error: '错误', performance: '性能', environment: '环境' };
  return map[type] || type;
}

function formatDataSummary(type: string, data: Record<string, any>): string {
  if (!data) return '-';
  if (type === 'error') return '消息: ' + (data.message || '-') + ' · 标签: ' + (data.tag || '-');
  if (type === 'performance') return '页面加载: ' + (data.pageLoad ?? '-') + 'ms · URL: ' + (data.url || '-');
  if (type === 'environment') return '屏幕: ' + (data.screen || '-') + ' · 视口: ' + (data.viewport || '-') + ' · 平台: ' + (data.platform || '-');
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
  if (isNaN(d.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function formatFullTime(t: string): string {
  if (!t) return '-';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString('zh-CN', { hour12: false });
}

function formatJson(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function openDetail(row: RecordItem) {
  detailRecord.value = row;
  detailVisible.value = true;
}

// ---- API 请求 ----
async function fetchStats() {
  const gen = ++statsGen;
  try {
    const res = await client.get('/admin/telemetry/stats', { params: { timeRange: timeRange.value } });
    if (gen !== statsGen) return; // 已被更新的请求取代
    Object.assign(stats, res.data.data || res.data);
    await nextTick();
    updateTrendChart();
    updatePieChart();
  } catch (e) {
    if (gen === statsGen) console.error('获取遥测统计失败:', e);
  }
}

async function fetchRecords() {
  const gen = ++recordsGen;
  recordsAbort?.abort();
  recordsAbort = new AbortController();
  recordsLoading.value = true;
  try {
    const res = await client.get('/admin/telemetry/records', {
      params: {
        page: pagination.current,
        limit: pagination.pageSize,
        type: typeFilter.value || undefined,
        timeRange: timeRange.value,
      },
      signal: recordsAbort.signal,
    });
    if (gen !== recordsGen) return;
    const body = res.data.data || res.data;
    records.value = body.items || [];
    pagination.total = body.total || 0;
  } catch (e) {
    if (gen === recordsGen) console.error('获取遥测记录失败:', e);
  } finally {
    if (gen === recordsGen) recordsLoading.value = false;
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

async function refreshAll(silent = false) {
  if (!silent) refreshing.value = true;
  try {
    await Promise.all([fetchStats(), fetchRecords(), fetchErrors(), fetchPerformance()]);
    lastRefreshTime.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  } finally {
    refreshing.value = false;
  }
}

function onTimeRangeChange() {
  pagination.current = 1;
  refreshAll();
}

function onTypeFilterChange() {
  pagination.current = 1;
  fetchRecords();
}

// 点击指标卡筛选记录并滚动到记录区
function filterByType(type: string) {
  typeFilter.value = type;
  pagination.current = 1;
  fetchRecords();
  const el = document.querySelector('.record-tools');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function onPageChange(pageInfo: { current: number; pageSize: number }) {
  pagination.current = pageInfo.current;
  pagination.pageSize = pageInfo.pageSize;
  fetchRecords();
}

// ---- 自动刷新（页面隐藏时暂停） ----
function startAutoRefresh() {
  stopAutoRefresh();
  const sec = autoRefreshInterval.value;
  if (!sec) return;
  autoRefreshTimer = setInterval(() => {
    if (document.hidden) return; // 后台标签页不刷新，节省资源
    refreshAll(true);
  }, sec * 1000);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function onAutoRefreshChange() {
  startAutoRefresh();
}

// ---- ECharts ----
const trendChartRef = ref<HTMLDivElement | null>(null);
const pieChartRef = ref<HTMLDivElement | null>(null);
const perfChartRef = ref<HTMLDivElement | null>(null);
let trendChart: echarts.ECharts | null = null;
let pieChart: echarts.ECharts | null = null;
let perfChart: echarts.ECharts | null = null;
let resizeObserver: ResizeObserver | null = null;

async function initCharts() {
  await ensureCyberTheme();
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
    grid: { left: 50, right: 20, top: 36, bottom: 30 },
    xAxis: { type: 'category', data: times, boundaryGap: false, axisLabel: { color: axisLabelColor(), fontSize: 11 } },
    yAxis: { type: 'value', axisLabel: { color: axisLabelColor(), fontSize: 11 } },
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
      center: ['62%', '50%'],
      label: { color: axisLabelColor() },
      emphasis: { itemStyle: { shadowBlur: 20, shadowColor: isDark() ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.15)' } },
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
  const reversed = [...top10].reverse();
  const labels = reversed.map(p => {
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
        if (!params || !params.length) return '';
        const idx = params[0].dataIndex;
        const p = reversed[idx];
        if (!p) return '';
        const lines = params.map((s: any) => s.marker + ' ' + s.seriesName + ': ' + s.value + 'ms').join('<br/>');
        return '<b>' + p.url + '</b><br/>' + lines + '<br/>总计: ' + p.pageLoad + 'ms · 样本: ' + p.count;
      },
    },
    legend: { data: stages.map(s => s.name), ...legendBase, bottom: 0 },
    grid: { left: 110, right: 40, top: 10, bottom: 40 },
    xAxis: { type: 'value', name: 'ms', nameTextStyle: { color: axisLabelColor(), fontSize: 11 }, axisLabel: { color: axisLabelColor(), fontSize: 11 } },
    yAxis: { type: 'category', data: labels, axisLabel: { color: axisLabelColor(), fontSize: 11, width: 100, overflow: 'truncate' } },
    series: stages.map(stage => ({
      name: stage.name,
      type: 'bar',
      stack: 'total',
      emphasis: { focus: 'series' },
      itemStyle: { color: stage.color },
      data: reversed.map(p => (p as any)[stage.key] || 0),
    })),
  });
}

// ---- 生命周期 ----
onMounted(async () => {
  // 关键修复：先 await 初始化图表实例，再拉取数据，
  // 避免首屏数据到达时图表尚未创建而不渲染。
  await initCharts();
  await refreshAll();

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
  stopAutoRefresh();
  recordsAbort?.abort();
  trendChart?.dispose();
  pieChart?.dispose();
  perfChart?.dispose();
  resizeObserver?.disconnect();
});
</script>

<style scoped>
.telemetry-page {
  padding: 20px;
  max-width: 1400px;
  margin: 0 auto;
}

/* 页头 */
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.head-title h1 {
  font-size: 24px;
  margin: 0 0 4px;
}
.head-title p {
  color: var(--text-secondary);
  margin: 0;
  font-size: 14px;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.btn-icon { font-size: 14px; line-height: 1; }
.last-update {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0 0 16px;
}

/* 指标卡片：auto-fit 自适应列数，避免平板宽度拥挤 */
.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.metric-card {
  background: var(--bg-secondary);
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 16px 18px;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.1s;
}
.metric-card:hover { transform: translateY(-2px); }
.metric-card.active { border-color: var(--color-accent); }
.metric-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}
.metric-value {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.1;
}
.metric-danger .metric-value.has-value { color: var(--color-danger); }
.metric-success .metric-value { color: var(--color-success); }
.metric-sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 6px;
}

/* 图表区 */
.charts {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 16px;
  margin-bottom: 16px;
}
.card {
  background: var(--bg-secondary);
  border-radius: 10px;
  padding: 16px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.card-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.chart-box {
  height: 300px;
  width: 100%;
}
.chart-perf { height: 360px; }

.section { margin-bottom: 16px; }

/* 性能概览摘要 chips */
.perf-summary {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.chip {
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--color-bg-hover);
  border-radius: 6px;
  padding: 3px 10px;
}
.chip b { color: var(--text-primary); }

.count-badge {
  font-size: 12px;
  background: var(--color-danger);
  color: #fff;
  border-radius: 10px;
  padding: 1px 8px;
}

.record-tools {
  display: flex;
  gap: 10px;
  align-items: center;
}

/* 自定义省略号单元格：CSS 截断 + 原生 title 悬浮提示（替代 TDesign ellipsis 组件） */
.cell-ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.empty {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary);
}

/* 详情抽屉 */
.detail-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 16px;
}
.detail-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.detail-item.full { grid-column: 1 / -1; }
.d-label {
  font-size: 12px;
  color: var(--text-secondary);
}
.d-value {
  font-size: 13px;
  color: var(--text-primary);
  word-break: break-all;
}
.d-value.mono { font-family: var(--font-mono); font-size: 12px; }
.d-value.wrap { white-space: pre-wrap; }
.detail-data { display: flex; flex-direction: column; gap: 8px; }
.json-block {
  background: var(--bg-color, rgba(0,0,0,0.25));
  border-radius: 8px;
  padding: 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  max-height: 420px;
  overflow: auto;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 响应式 */
@media (max-width: 900px) {
  .charts { grid-template-columns: 1fr; }
}
@media (max-width: 500px) {
  .metric-value { font-size: 22px; }
  .chart-box { height: 240px; }
  .detail-grid { grid-template-columns: 1fr; }
}
</style>
