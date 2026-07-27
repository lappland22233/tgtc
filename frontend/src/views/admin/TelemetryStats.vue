<template>
  <div class="telemetry-page">
    <!-- 页头：标题 + 全局控制 -->
    <header class="page-header telemetry-header">
      <div>
        <h1>遥测监控</h1>
        <p>前端错误、页面性能与设备环境的统计与诊断</p>
      </div>
      <div class="head-actions">
        <div class="header-control">
          <span id="time-range-label" class="control-label">时间范围</span>
          <t-radio-group v-model="timeRange" aria-labelledby="time-range-label" variant="default-filled" size="small" @change="onTimeRangeChange">
            <t-radio-button value="1h">1小时</t-radio-button>
            <t-radio-button value="24h">24小时</t-radio-button>
            <t-radio-button value="7d">7天</t-radio-button>
            <t-radio-button value="30d">30天</t-radio-button>
          </t-radio-group>
        </div>

        <div class="header-control auto-refresh-control">
          <label class="control-label" for="telemetry-auto-refresh">自动刷新</label>
          <t-select
            id="telemetry-auto-refresh"
            v-model="autoRefreshInterval"
            aria-label="自动刷新频率"
            size="small"
            :options="autoRefreshOptions"
            @change="onAutoRefreshChange"
          />
        </div>

        <t-button size="small" :loading="refreshing" @click="refreshAll">
          <template #icon>
            <svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20 11a8 8 0 10-2.34 5.66" />
              <path d="M20 4v7h-7" />
            </svg>
          </template>
          刷新
        </t-button>
      </div>
    </header>

    <p v-if="lastRefreshTime" class="last-update">最后更新：{{ lastRefreshTime }}</p>

    <!-- 核心指标卡片（可点击筛选记录） -->
    <section class="metrics" aria-label="遥测核心指标">
      <button type="button" class="metric-card" :class="{ active: typeFilter === '' }" @click="filterByType('')">
        <span class="metric-label">总记录数</span>
        <span class="metric-value">{{ formatNumber(stats.totalRecords) }}</span>
        <span class="metric-sub">选定时间范围内 · 点击查看全部</span>
      </button>
      <button type="button" class="metric-card metric-danger" :class="{ active: isErrorFilterActive }" @click="filterByType('error')">
        <span class="metric-label">错误数</span>
        <span class="metric-value" :class="{ 'has-value': errorCount > 0 }">{{ formatNumber(errorCount) }}</span>
        <span class="metric-sub">{{ errorRate }}% 错误率</span>
      </button>
      <button type="button" class="metric-card metric-success" :class="{ active: typeFilter === 'performance' }" @click="filterByType('performance')">
        <span class="metric-label">性能记录</span>
        <span class="metric-value">{{ formatNumber(stats.byType.performance) }}</span>
        <span class="metric-sub">页面加载指标</span>
      </button>
      <div class="metric-card metric-static">
        <span class="metric-label">独立设备</span>
        <span class="metric-value">{{ formatNumber(stats.uniqueIPs) }}</span>
        <span class="metric-sub">去重 IP 统计</span>
      </div>
    </section>

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
      <div v-if="errors.length === 0" class="empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 6L9 17l-5-5" />
        </svg>
        <span>暂无错误记录</span>
      </div>
      <t-table
        v-else-if="!isMobile"
        :data="errorsTop"
        :columns="errorColumns"
        row-key="id"
        size="small"
        max-height="420"
        hover
        @row-click="({ row }: any) => openDetail(row)"
      />
      <div v-else class="mobile-card-list">
        <button v-for="item in errorsTop" :key="item.id" type="button" class="mobile-record-card" @click="openDetail(item)">
          <div class="mobile-record-head">
            <span class="record-type">{{ typeBadge(item.type) }}</span>
            <time>{{ formatTime(item.createdAt) }}</time>
          </div>
          <strong>{{ item.data?.message || '未知错误' }}</strong>
          <div class="mobile-record-meta">
            <span>{{ errorTypeLabel(item.data?.tag) }}</span>
            <span>{{ item.ip || '-' }}</span>
          </div>
        </button>
      </div>
    </div>

    <!-- 遥测记录列表 -->
    <div class="card section">
      <div class="card-head record-head">
        <div>
          <h3>数据检索</h3>
          <p class="section-desc">按 IP、用户 ID、事件类型与报错类型组合筛选，并保留本页最近查询记录。</p>
        </div>
      </div>
      <form class="search-panel" @submit.prevent="applySearch">
        <label class="search-field" for="telemetry-ip">
          <span>IP 地址</span>
          <t-input id="telemetry-ip" v-model="ipFilter" name="telemetry-ip" autocomplete="off" placeholder="例如 203.0.113.10…" clearable size="small" />
        </label>
        <label class="search-field" for="telemetry-user-id">
          <span>用户 ID</span>
          <t-input id="telemetry-user-id" v-model="userIdFilter" name="telemetry-user-id" autocomplete="off" spellcheck="false" placeholder="输入完整 UUID…" clearable size="small" />
        </label>
        <label class="search-field" for="telemetry-event-type">
          <span>事件类型</span>
          <t-select id="telemetry-event-type" v-model="typeFilter" aria-label="事件类型" placeholder="全部事件类型…" clearable size="small">
            <t-option value="" label="全部事件类型" />
            <t-option value="error" label="运行时错误" />
            <t-option value="api_error" label="API 错误" />
            <t-option value="upload_error" label="上传错误" />
            <t-option value="performance" label="性能" />
            <t-option value="environment" label="环境" />
            <t-option value="click_context" label="点击上下文" />
          </t-select>
        </label>
        <label class="search-field" for="telemetry-error-type">
          <span>报错类型</span>
          <t-select id="telemetry-error-type" v-model="errorTypeFilter" aria-label="报错类型" placeholder="全部报错类型…" clearable size="small">
            <t-option v-for="option in errorTypeOptions" :key="option.value" :value="option.value" :label="option.label" />
          </t-select>
        </label>
        <label class="search-field" for="telemetry-keyword">
          <span>关键词</span>
          <t-input id="telemetry-keyword" v-model="keywordFilter" name="telemetry-keyword" autocomplete="off" placeholder="消息、URL、文件名或错误码…" clearable size="small" />
        </label>
        <div class="search-actions">
          <t-button theme="primary" size="small" type="submit">查询</t-button>
          <t-button variant="outline" size="small" type="button" @click="resetSearch">重置</t-button>
        </div>
      </form>
      <div v-if="searchHistory.length > 0" class="search-history">
        <span class="history-label">最近查询</span>
        <button v-for="item in searchHistory" :key="item.id" type="button" class="history-item" @click="restoreSearch(item)">
          <span>{{ item.summary }}</span>
          <time>{{ item.time }}</time>
        </button>
      </div>
      <t-table
        v-if="!isMobile"
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
      <t-loading v-else :loading="recordsLoading" size="small">
        <div v-if="records.length === 0 && !recordsLoading" class="empty-state">
          <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <span>未找到符合条件的遥测记录</span>
        </div>
        <div v-else class="mobile-card-list">
          <button v-for="item in records" :key="item.id" type="button" class="mobile-record-card" @click="openDetail(item)">
            <div class="mobile-record-head">
              <span class="record-type">{{ typeBadge(item.type) }}</span>
              <time>{{ formatTime(item.createdAt) }}</time>
            </div>
            <strong>{{ formatDataSummary(item.type, item.data) }}</strong>
            <div class="mobile-record-meta">
              <span>{{ errorTypeLabel(item.data?.tag) }}</span>
              <span>{{ item.userId || '匿名用户' }}</span>
              <span>{{ item.ip || '-' }}</span>
            </div>
          </button>
          <div v-if="records.length > 0" class="mobile-pagination">
            <t-pagination
              :current="pagination.current"
              :total="pagination.total"
              :page-size="pagination.pageSize"
              size="small"
              :show-jumper="false"
              @change="onPageChange"
            />
          </div>
        </div>
      </t-loading>
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
          <div class="detail-item"><span class="d-label">用户 ID</span><span class="d-value mono">{{ detailRecord.userId || '匿名用户' }}</span></div>
          <div class="detail-item"><span class="d-label">报错类型</span><span class="d-value">{{ errorTypeLabel(detailRecord.data?.tag) }}</span></div>
          <div class="detail-item"><span class="d-label">客户端时间</span><span class="d-value">{{ formatClientTimestamp(detailRecord.clientTimestamp) }}</span></div>
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
import { useRoute, useRouter } from 'vue-router';
import * as echarts from '@/utils/echarts';
import client from '../../api/client';
import { useMobile } from '../../composables/useMobile';
import { CHART_COLORS, tooltipBase, legendBase, areaGradient, ensureCyberTheme } from '../../utils/echarts-theme';

// Theme-aware chart colors
const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';
const axisLabelColor = () => isDark() ? '#8895A7' : '#5F6B7A';

const route = useRoute();
const router = useRouter();
const isMobile = useMobile();
const validTimeRanges = new Set(['1h', '24h', '7d', '30d']);
const queryString = (value: unknown): string => typeof value === 'string' ? value : '';
const queryPositiveInt = (value: unknown, fallback: number): number => {
  const parsed = Number.parseInt(queryString(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// ---- 时间范围 ----
const initialTimeRange = queryString(route.query.timeRange);
const timeRange = ref(validTimeRanges.has(initialTimeRange) ? initialTimeRange : '24h');
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
  byType: Record<string, number>;
  uniqueIPs: number;
  trend: { time: string; error: number; apiError: number; uploadError: number; performance: number; environment: number }[];
}
const stats = reactive<Stats>({
  totalRecords: 0,
  byType: { error: 0, api_error: 0, upload_error: 0, performance: 0, environment: 0, click_context: 0 },
  uniqueIPs: 0,
  trend: [],
});

const errorCount = computed(() =>
  (stats.byType.error || 0) + (stats.byType.api_error || 0) + (stats.byType.upload_error || 0),
);
const errorRate = computed(() => {
  if (stats.totalRecords === 0) return '0.0';
  return ((errorCount.value / stats.totalRecords) * 100).toFixed(1);
});

// ---- 记录列表 ----
interface RecordItem {
  id: string;
  type: string;
  data: Record<string, any>;
  ip: string;
  userId: string | null;
  userAgent: string | null;
  clientTimestamp: number | string | null;
  createdAt: string;
}
const records = ref<RecordItem[]>([]);
const recordsLoading = ref(false);
const typeFilter = ref(queryString(route.query.type));
const ipFilter = ref(queryString(route.query.ip));
const userIdFilter = ref(queryString(route.query.userId));
const errorTypeFilter = ref(queryString(route.query.errorType));
const keywordFilter = ref(queryString(route.query.keyword));
const errorTypeOptions = [
  { label: '未捕获异常', value: 'uncaught' },
  { label: 'Promise 拒绝', value: 'unhandled_rejection' },
  { label: 'Vue 组件错误', value: 'vue' },
  { label: '组件渲染失败', value: 'render_failure' },
  { label: '资源加载失败', value: 'asset_error' },
  { label: '白屏', value: 'white_screen' },
  { label: '后端错误响应', value: 'backend_response' },
  { label: '服务端错误', value: 'server_response' },
  { label: '网络失败', value: 'network_failure' },
  { label: '上传大小校验', value: 'validation_size' },
  { label: '上传类型校验', value: 'validation_type' },
  { label: '异步上传', value: 'async_upload' },
  { label: '分片初始化', value: 'chunk_init' },
  { label: '分片上传', value: 'chunk_upload' },
  { label: '分片合并轮询', value: 'chunk_merge_poll' },
];
interface SearchHistoryItem {
  id: string;
  summary: string;
  time: string;
  filters: { type: string; ip: string; userId: string; errorType: string; keyword: string };
}
const searchHistory = ref<SearchHistoryItem[]>([]);
const pagination = reactive({
  current: queryPositiveInt(route.query.page, 1),
  pageSize: Math.min(queryPositiveInt(route.query.pageSize, 20), 100),
  total: 0,
  showJumper: true,
});
const isErrorFilterActive = computed(() => ['error', 'api_error', 'upload_error'].includes(typeFilter.value));

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
  { colKey: 'type', title: '类型', width: 100, cell: (_h: unknown, ctx: { row: RecordItem }) => typeBadge(ctx.row.type) },
  { colKey: 'data.tag', title: '报错类型', width: 130, cell: (_h: unknown, ctx: { row: RecordItem }) => errorTypeLabel(ctx.row.data?.tag) },
  { colKey: 'ip', title: 'IP', width: 130 },
  { colKey: 'userId', title: '用户 ID', width: 170, cell: (_h: unknown, ctx: { row: RecordItem }) => ellipsisCell(ctx.row.userId || '匿名用户') },
  { colKey: 'data', title: '数据摘要', cell: (_h: unknown, ctx: { row: RecordItem }) => ellipsisCell(formatDataSummary(ctx.row.type, ctx.row.data)) },
];

function typeBadge(type: string): string {
  const map: Record<string, string> = {
    error: '运行时错误',
    api_error: 'API 错误',
    upload_error: '上传错误',
    performance: '性能',
    environment: '环境',
    click_context: '点击上下文',
  };
  return map[type] || type;
}

function errorTypeLabel(tag?: string): string {
  if (!tag) return '-';
  return errorTypeOptions.find(option => option.value === tag)?.label || tag;
}

function formatDataSummary(type: string, data: Record<string, any>): string {
  if (!data) return '-';
  if (type === 'error') return '消息: ' + (data.message || '-') + ' · 标签: ' + errorTypeLabel(data.tag);
  if (type === 'api_error') return `${data.method || 'GET'} ${data.url || '-'} · ${data.status || 0} · ${data.message || '-'}`;
  if (type === 'upload_error') return `${data.fileName || '-'} · ${errorTypeLabel(data.tag)} · ${data.message || '-'}`;
  if (type === 'performance') return '页面加载: ' + (data.pageLoad ?? '-') + 'ms · URL: ' + (data.url || '-');
  if (type === 'environment') return '屏幕: ' + (data.screen || '-') + ' · 视口: ' + (data.viewport || '-') + ' · 平台: ' + (data.platform || '-');
  if (type === 'click_context') return `窗口: ${data.window || '-'} · 点击数: ${data.totalClicks || 0}`;
  return JSON.stringify(data).slice(0, 160);
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

function formatClientTimestamp(timestamp: number | string | null): string {
  if (timestamp == null || timestamp === '') return '-';
  const value = typeof timestamp === 'number' ? timestamp : Number(timestamp);
  if (!Number.isFinite(value)) return '-';
  const d = new Date(value);
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
        ip: ipFilter.value.trim() || undefined,
        userId: userIdFilter.value.trim() || undefined,
        errorType: errorTypeFilter.value || undefined,
        keyword: keywordFilter.value.trim() || undefined,
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

function syncQueryState() {
  const query: Record<string, string> = {};
  if (timeRange.value !== '24h') query.timeRange = timeRange.value;
  if (typeFilter.value) query.type = typeFilter.value;
  if (ipFilter.value.trim()) query.ip = ipFilter.value.trim();
  if (userIdFilter.value.trim()) query.userId = userIdFilter.value.trim();
  if (errorTypeFilter.value) query.errorType = errorTypeFilter.value;
  if (keywordFilter.value.trim()) query.keyword = keywordFilter.value.trim();
  if (pagination.current > 1) query.page = String(pagination.current);
  if (pagination.pageSize !== 20) query.pageSize = String(pagination.pageSize);
  void router.replace({ query });
}

function onTimeRangeChange() {
  pagination.current = 1;
  syncQueryState();
  refreshAll();
}

function buildSearchSummary(): string {
  const parts = [
    typeFilter.value ? typeBadge(typeFilter.value) : '',
    ipFilter.value.trim() ? `IP ${ipFilter.value.trim()}` : '',
    userIdFilter.value.trim() ? `用户 ${userIdFilter.value.trim()}` : '',
    errorTypeFilter.value ? errorTypeLabel(errorTypeFilter.value) : '',
    keywordFilter.value.trim() ? `关键词 ${keywordFilter.value.trim()}` : '',
  ].filter(Boolean);
  return parts.join(' · ') || '全部记录';
}

function applySearch() {
  pagination.current = 1;
  const filters = {
    type: typeFilter.value,
    ip: ipFilter.value.trim(),
    userId: userIdFilter.value.trim(),
    errorType: errorTypeFilter.value,
    keyword: keywordFilter.value.trim(),
  };
  const signature = JSON.stringify(filters);
  searchHistory.value = [
    {
      id: `${Date.now()}-${signature}`,
      summary: buildSearchSummary(),
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }),
      filters,
    },
    ...searchHistory.value.filter(item => JSON.stringify(item.filters) !== signature),
  ].slice(0, 5);
  syncQueryState();
  fetchRecords();
}

function resetSearch() {
  typeFilter.value = '';
  ipFilter.value = '';
  userIdFilter.value = '';
  errorTypeFilter.value = '';
  keywordFilter.value = '';
  applySearch();
}

function restoreSearch(item: SearchHistoryItem) {
  typeFilter.value = item.filters.type;
  ipFilter.value = item.filters.ip;
  userIdFilter.value = item.filters.userId;
  errorTypeFilter.value = item.filters.errorType;
  keywordFilter.value = item.filters.keyword;
  pagination.current = 1;
  syncQueryState();
  fetchRecords();
}

// 点击指标卡筛选记录并滚动到检索区
function filterByType(type: string) {
  typeFilter.value = type;
  applySearch();
  const el = document.querySelector('.search-panel');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function onPageChange(pageInfo: { current: number; pageSize: number }) {
  pagination.current = pageInfo.current;
  pagination.pageSize = pageInfo.pageSize;
  syncQueryState();
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
      { name: '错误', type: 'line', data: stats.trend.map(t => t.error + t.apiError + t.uploadError), smooth: true, lineStyle: { color: CHART_COLORS.danger, width: 2 }, itemStyle: { color: CHART_COLORS.danger }, areaStyle: { color: areaGradient(CHART_COLORS.danger) }, symbol: 'none' },
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
        { name: '错误', value: errorCount.value, itemStyle: { color: CHART_COLORS.danger } },
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
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
}

.telemetry-header {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-4);
}
.head-actions {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-3);
}
.header-control,
.search-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.control-label,
.search-field > span {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
}
.auto-refresh-control { min-width: 132px; }
.button-icon,
.empty-icon {
  width: 18px;
  height: 18px;
}
.last-update {
  margin: 0 0 var(--space-4);
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.metrics {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.metric-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  min-height: 108px;
  padding: var(--space-4);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  color: var(--text-primary);
  text-align: left;
  transition:
    border-color var(--duration-normal) var(--ease-out-expo),
    box-shadow var(--duration-normal) var(--ease-out-expo),
    transform var(--duration-fast) var(--ease-out-expo);
}
button.metric-card { cursor: pointer; }
button.metric-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
  transform: translateY(-2px);
}
button.metric-card:active { transform: translateY(0); }
.metric-card.active { border-color: var(--border-accent); }
.metric-static { cursor: default; }
.metric-label {
  margin-bottom: var(--space-2);
  color: var(--text-secondary);
  font-size: 12px;
}
.metric-value {
  font-family: var(--font-mono);
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.metric-danger .metric-value.has-value { color: var(--color-danger); }
.metric-success .metric-value { color: var(--color-success); }
.metric-sub {
  margin-top: var(--space-2);
  color: var(--text-secondary);
  font-size: 12px;
}

.charts {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
  flex-wrap: wrap;
}
.card-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.chart-box {
  width: 100%;
  height: 240px;
}
.chart-perf { height: 300px; }
.section { margin-bottom: var(--space-4); }

.perf-summary {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.chip {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-bg-hover);
  color: var(--text-secondary);
  font-size: 12px;
}
.chip b { color: var(--text-primary); }
.count-badge {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-danger);
  color: var(--color-bg-surface);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.section-desc {
  margin: var(--space-1) 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}

.search-panel {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-3);
  padding: var(--space-3);
  margin-bottom: var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--color-bg-hover);
}
.search-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
  align-items: end;
}
.search-history {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  flex-wrap: wrap;
}
.history-label {
  width: 100%;
  color: var(--text-secondary);
  font-size: 12px;
}
.history-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 44px;
  max-width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
  transition:
    border-color var(--duration-fast) var(--ease-out-expo),
    background-color var(--duration-fast) var(--ease-out-expo);
}
.history-item:hover { border-color: var(--border-strong); background: var(--color-bg-hover); }
.history-item:active { background: var(--color-bg-selected); }
.history-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-item time { flex: 0 0 auto; color: var(--text-secondary); font-family: var(--font-mono); }

.cell-ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.empty,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8);
  color: var(--text-secondary);
  text-align: center;
}
.empty-icon { color: var(--color-success); }
.mobile-card-list {
  display: grid;
  gap: var(--space-3);
}
.mobile-record-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  min-height: 44px;
  padding: var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  color: var(--text-primary);
  text-align: left;
  transition:
    border-color var(--duration-fast) var(--ease-out-expo),
    background-color var(--duration-fast) var(--ease-out-expo);
}
.mobile-record-card:hover { border-color: var(--border-strong); background: var(--color-bg-hover); }
.mobile-record-card:active { background: var(--color-bg-selected); }
.mobile-record-card strong {
  overflow-wrap: anywhere;
  font-size: 13px;
  font-weight: 500;
}
.mobile-record-head,
.mobile-record-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.mobile-record-head time,
.mobile-record-meta {
  color: var(--text-secondary);
  font-size: 11px;
}
.mobile-record-meta {
  justify-content: flex-start;
  flex-wrap: wrap;
}
.record-type {
  color: var(--text-accent);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
}
.mobile-pagination {
  display: flex;
  justify-content: center;
  padding-top: var(--space-2);
}

.detail-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.detail-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-3) var(--space-4);
}
.detail-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.detail-item.full { grid-column: 1 / -1; }
.d-label { color: var(--text-secondary); font-size: 12px; }
.d-value { color: var(--text-primary); font-size: 13px; word-break: break-all; }
.d-value.mono { font-family: var(--font-mono); font-size: 12px; }
.d-value.wrap { white-space: pre-wrap; }
.detail-data { display: flex; flex-direction: column; gap: var(--space-2); }
.json-block {
  max-height: 420px;
  overflow: auto;
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--color-bg-overlay);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

@media (min-width: 481px) {
  .metrics { grid-template-columns: repeat(2, 1fr); }
  .search-panel { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .search-actions { grid-column: 1 / -1; justify-self: end; display: flex; }
  .detail-grid { grid-template-columns: 1fr 1fr; }
}
@media (min-width: 769px) {
  .telemetry-header { flex-direction: row; align-items: flex-start; justify-content: space-between; }
  .head-actions { flex-direction: row; align-items: flex-end; flex-wrap: wrap; }
  .metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .metric-value { font-size: 28px; }
  .charts { grid-template-columns: 2fr 1fr; }
  .chart-box { height: 300px; }
  .chart-perf { height: 360px; }
  .search-panel { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .search-actions { grid-column: auto; }
  .history-label { width: auto; }
}
@media (min-width: 1025px) {
  .search-panel { grid-template-columns: repeat(5, minmax(0, 1fr)) auto; }
}
@media (hover: none) and (pointer: coarse) {
  button.metric-card:hover { transform: none; border-color: var(--border-default); box-shadow: none; }
  .history-item,
  .mobile-record-card { min-height: 44px; }
}
</style>
