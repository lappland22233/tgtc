<template>
  <div class="access-logs-page">
    <div class="page-header">
      <h1>访问统计</h1>
      <p>网站请求量、带宽消耗、独立访客、流量峰值、来源分析与文件类型统计</p>
    </div>

    <!-- Top-level Tabs -->
    <!-- destroy-on-hide=false（G14-05）：子面板（来源/带宽/文件类型）切换时保持挂载，
         避免其 onMounted 重新拉取数据（G14-11/13/15 一并修复）；配合 accessTab watch 做图表 resize -->
    <t-tabs v-model="accessTab" destroy-on-hide="false">
      <t-tab-panel value="overview" label="概览">
    <!-- Template content continues... -->

    <!-- 时间范围选择器和自动刷新 -->
    <div class="toolbar">
      <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <t-radio-group v-model="timeRange" variant="default-filled" @change="onTimeRangeChange">
          <t-radio-button value="1h">1小时</t-radio-button>
          <t-radio-button value="24h">24小时</t-radio-button>
          <t-radio-button value="7d">7天</t-radio-button>
          <t-radio-button value="30d">30天</t-radio-button>
        </t-radio-group>
        <div style="display: flex; gap: 8px; align-items: center; margin-left: auto;">
          <label style="font-size: 12px; color: var(--text-secondary); white-space: nowrap;">自动刷新：</label>
          <t-select
            v-model="autoRefreshInterval"
            style="width: 100px;"
            :popup-props="{ overlayStyle: { minWidth: '100px' } }"
            @change="updateAutoRefresh"
          >
            <t-option :value="0" label="关闭" />
            <t-option :value="30000" label="30秒" />
            <t-option :value="60000" label="1分钟" />
            <t-option :value="300000" label="5分钟" />
          </t-select>
          <span v-if="lastRefreshTime" style="font-size: 12px; color: var(--text-secondary); white-space: nowrap;">
            最后更新：{{ lastRefreshTime }}
          </span>
          <t-button
            variant="outline"
            size="small"
            :loading="refreshing"
            @click="onRefresh"
          >
            刷新
          </t-button>
        </div>
      </div>
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
        <div class="metric-value">{{ formatSizeUtil(stats.totalBandwidth) }}</div>
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

    <!-- 文件访问排行 -->
    <div class="card section-card">
      <div class="section-header">
        <h3>文件访问排行</h3>
        <t-radio-group v-model="topFilesSortBy" variant="default-filled" size="small" @change="fetchTopFiles">
          <t-radio-button value="accessCount">按访问次数</t-radio-button>
          <t-radio-button value="totalBandwidth">按带宽</t-radio-button>
        </t-radio-group>
      </div>
      <t-loading :loading="topFilesLoading" size="small">
        <t-table
          :data="topFilesWithRank"
          :columns="topFilesColumns"
          row-key="fileName"
          table-layout="fixed"
          :pagination="false"
          size="small"
        >
          <template #rank="{ rowIndex }">
            <span class="rank-badge" :class="'rank-' + (rowIndex + 1)">{{ rowIndex + 1 }}</span>
          </template>
          <template #fileName="{ row }">
            <span class="file-name-cell">
              <FileTypeIcon :mimeType="row.mimeType" :fileName="row.fileName" :size="16" />
              <span>{{ row.fileName }}</span>
            </span>
          </template>
          <template #accessCount="{ row }">
            {{ formatNumber(row.accessCount) }}
          </template>
          <template #totalBandwidth="{ row }">
            {{ formatSizeUtil(row.totalBandwidth) }}
          </template>
        </t-table>
        <div v-if="!topFilesLoading && topFiles.length === 0" class="empty-hint">暂无数据</div>
      </t-loading>
    </div>

    <!-- 路径访问排行 -->
    <div class="card section-card">
      <h3 style="margin: 0 0 16px 0;">路径访问排行</h3>
      <t-loading :loading="topPathsLoading" size="small">
        <t-table
          :data="topPaths"
          :columns="topPathsColumns"
          row-key="path"
          table-layout="fixed"
          :pagination="false"
          size="small"
          max-height="500"
        >
          <template #path="{ row }">
            <t-tooltip placement="top" :content="row.path">
              <span class="path-truncate">{{ truncatePath(row.path, 50) }}</span>
            </t-tooltip>
          </template>
          <template #requestCount="{ row }">
            {{ formatNumber(row.requestCount) }}
          </template>
          <template #totalBandwidth="{ row }">
            {{ formatSizeUtil(row.totalBandwidth) }}
          </template>
          <template #avgDuration="{ row }">
            {{ Number(row.avgDuration ?? 0).toFixed(1) }}ms
          </template>
        </t-table>
        <div v-if="!topPathsLoading && topPaths.length === 0" class="empty-hint">暂无数据</div>
      </t-loading>
    </div>

    <!-- 异常 IP 监控 -->
    <div class="card section-card">
      <h3 style="margin: 0 0 16px 0;">异常 IP 监控</h3>
      <t-loading :loading="abnormalIpsLoading" size="small">
        <t-table
          :data="abnormalIps"
          :columns="abnormalIpsColumns"
          row-key="ip"
          table-layout="fixed"
          :pagination="false"
          size="small"
        >
          <template #ip="{ row }">
            <code class="ip-code">{{ row.ip }}</code>
          </template>
          <template #requestCount="{ row }">
            {{ formatNumber(row.requestCount) }}
          </template>
          <template #errorRate="{ row }">
            <span :class="'error-rate-' + errorRateLevel(row.errorRate)">
              {{ Number(row.errorRate ?? 0).toFixed(1) }}%
            </span>
          </template>
          <template #bandwidth="{ row }">
            {{ formatSizeUtil(row.bandwidth) }}
          </template>
          <template #riskLevel="{ row }">
            <t-tag :theme="riskTheme(row.riskLevel)" variant="light" size="small">
              {{ riskLabel(row.riskLevel) }}
            </t-tag>
          </template>
          <template #action="{ row }">
            <t-button
              variant="outline"
              size="small"
              theme="danger"
              @click="handleBanIp(row.ip)"
            >
              封禁
            </t-button>
          </template>
        </t-table>
        <div v-if="!abnormalIpsLoading && abnormalIps.length === 0" class="empty-hint">暂无异常 IP</div>
      </t-loading>
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
          autocomplete="off"
          name="access-filter-path"
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

      <!-- Desktop table -->
      <t-table
        v-if="!isMobile"
        :data="logs"
        :columns="columns"
        :loading="loading"
        :pagination="pagination"
        row-key="id"
        table-layout="fixed"
        @page-change="onPageChange"
      >
        <template #path="{ row }">
          <div class="path-cell" :title="row.path">
            <span class="path-text">{{ truncatePath(row.path, 60) }}</span>
            <t-tooltip v-if="row.path.length > 60" theme="light" placement="top">
              <template #content>
                <div style="max-width: 400px; word-break: break-all;">{{ row.path }}</div>
              </template>
              <span class="path-info-icon">&#9432;</span>
            </t-tooltip>
          </div>
        </template>
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
          {{ formatSizeUtil(row.responseSize) }}
        </template>
        <template #createdAt="{ row }">
          {{ formatTime(row.createdAt) }}
        </template>
      </t-table>

      <!-- Mobile cards -->
      <div v-if="isMobile" class="mobile-card-list">
        <t-loading :loading="loading" size="small">
          <div v-if="logs.length === 0 && !loading" class="empty-hint">暂无数据</div>
          <div v-for="item in logs" :key="item.id" class="mobile-access-card">
            <div class="mobile-access-header">
              <code class="mobile-access-ip">{{ item.ip }}</code>
              <div style="display: flex; gap: 6px; align-items: center;">
                <t-tag :theme="methodTheme(item.method)" variant="outline" size="small">{{ item.method }}</t-tag>
                <t-tag :theme="statusTheme(item.statusCode)" variant="light" size="small">{{ item.statusCode }}</t-tag>
              </div>
            </div>
            <div class="mobile-access-path">{{ truncatePath(item.path, 60) }}</div>
            <div class="mobile-access-meta">
              <span>{{ item.duration }}ms</span>
              <span>{{ formatSizeUtil(item.responseSize) }}</span>
              <span style="color: var(--text-secondary); font-size: 11px;">{{ formatTime(item.createdAt) }}</span>
            </div>
          </div>
          <div v-if="logs.length > 0" style="margin-top: 12px; display: flex; justify-content: center;">
            <t-pagination
              :current="pagination.current"
              :total="pagination.total"
              :page-size="pagination.pageSize"
              size="small"
              @change="onPageChange"
            />
          </div>
        </t-loading>
      </div>
    </div>
      </t-tab-panel>

      <t-tab-panel value="source" label="来源分析">
        <SourceAnalysis ref="sourceAnalysisRef" />
      </t-tab-panel>

      <t-tab-panel value="bandwidth" label="带宽分析">
        <BandwidthAnalysis ref="bandwidthRef" />
      </t-tab-panel>

      <t-tab-panel value="filetypes" label="文件类型">
        <FileTypeAnalysis ref="fileTypeRef" />
      </t-tab-panel>
    </t-tabs>

    <!-- 异常 IP 封禁对话框（原因 + 时长，G15-08） -->
    <t-dialog
      v-model:visible="banDialogVisible"
      header="封禁 IP"
      :confirm-btn="{ content: '确认封禁', theme: 'danger', loading: banDialogSaving }"
      :on-confirm="handleBanSubmit"
      width="460px"
    >
      <t-form label-width="80px">
        <t-form-item label="IP 地址">
          <t-input :value="banForm.ip" disabled />
        </t-form-item>
        <t-form-item label="封禁原因">
          <t-input v-model="banForm.reason" placeholder="封禁原因（选填）" autocomplete="off" name="accesslog-ban-reason" />
        </t-form-item>
        <t-form-item label="封禁类型">
          <t-radio-group v-model="banForm.isPermanent">
            <t-radio :value="false">临时封禁</t-radio>
            <t-radio :value="true">永久封禁</t-radio>
          </t-radio-group>
        </t-form-item>
        <t-form-item v-if="!banForm.isPermanent" label="封禁时长">
          <t-input-number
            v-model="banForm.durationHours"
            :min="1"
            :max="720"
            style="width: 120px"
          />
          <span style="margin-left: 8px; color: var(--text-secondary); font-size: 13px">小时</span>
        </t-form-item>
      </t-form>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import MessagePlugin from '@/utils/message';
import * as echarts from '@/utils/echarts';
import client from '../../api/client';
import { formatSize as formatSizeUtil } from '@/utils/format';
import FileTypeIcon from '@/components/FileTypeIcon.vue';
import SourceAnalysis from './SourceAnalysis.vue';
import BandwidthAnalysis from './BandwidthAnalysis.vue';
import FileTypeAnalysis from './FileTypeAnalysis.vue';
import { useMobile } from '../../composables/useMobile';
import { CHART_COLORS, STATUS_COLORS, tooltipBase, legendBase, areaGradient, ensureCyberTheme } from '../../utils/echarts-theme';

// Theme-aware chart colors
const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';
const axisLabelColor = () => isDark() ? '#8895A7' : '#5F6B7A';
const axisLineColor = () => isDark() ? 'rgba(232,237,245,0.12)' : 'rgba(22,25,31,0.12)';
const splitLineColor = () => isDark() ? 'rgba(232,237,245,0.06)' : 'rgba(22,25,31,0.06)';

// Top-level tab state
const accessTab = ref('overview');

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

interface TopFileItem {
  fileName: string;
  mimeType: string;
  accessCount: number;
  totalBandwidth: number;
}

interface TopPathItem {
  path: string;
  requestCount: number;
  totalBandwidth: number;
  avgDuration: number;
}

interface AbnormalIpItem {
  ip: string;
  requestCount: number;
  errorRate: number;
  bandwidth: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
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

// New section state
const topFiles = ref<TopFileItem[]>([]);
const topFilesSortBy = ref<'accessCount' | 'totalBandwidth'>('accessCount');
const topFilesLoading = ref(false);
const topPaths = ref<TopPathItem[]>([]);
const topPathsLoading = ref(false);
const abnormalIps = ref<AbnormalIpItem[]>([]);
const abnormalIpsLoading = ref(false);

// Top files with computed rank
const topFilesWithRank = computed(() =>
  topFiles.value.map((item, index) => ({ ...item, _rank: index + 1 })),
);

// Top files table columns
const topFilesColumns = [
  { colKey: 'rank', title: '#', width: 50 },
  { colKey: 'fileName', title: '文件名', width: 200 },
  { colKey: 'mimeType', title: '类型', width: 100 },
  { colKey: 'accessCount', title: '访问次数', width: 110 },
  { colKey: 'totalBandwidth', title: '带宽消耗', width: 110 },
];

// Top paths table columns
const topPathsColumns = [
  { colKey: 'path', title: '请求路径', ellipsis: false, width: 300 },
  { colKey: 'requestCount', title: '请求数', width: 100 },
  { colKey: 'totalBandwidth', title: '带宽', width: 100 },
  { colKey: 'avgDuration', title: '平均耗时', width: 100 },
];

// Abnormal IPs table columns
const abnormalIpsColumns = [
  { colKey: 'ip', title: 'IP 地址', width: 150 },
  { colKey: 'requestCount', title: '请求数', width: 90 },
  { colKey: 'errorRate', title: '错误率', width: 90 },
  { colKey: 'bandwidth', title: '带宽', width: 90 },
  { colKey: 'riskLevel', title: '风险等级', width: 90 },
  { colKey: 'action', title: '操作', width: 80 },
];

// Charts
const trendChartRef = ref<HTMLDivElement | null>(null);
const pieChartRef = ref<HTMLDivElement | null>(null);
let trendChart: echarts.ECharts | null = null;
let pieChart: echarts.ECharts | null = null;

const isMobile = useMobile();

// ECharts resize handling for mobile
const handleResize = () => {
  trendChart?.resize();
  pieChart?.resize();
};
watch(isMobile, () => { nextTick(() => setTimeout(handleResize, 100)); });

// Auto-refresh
const autoRefreshInterval = ref(0);
const trendData = ref<TrendItem[]>([]);
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
const lastRefreshTime = ref('');
// 每次 refreshAll 自增；各 fetch 捕获当前代际，响应回来时若代际已变（有更新的刷新）则丢弃，
// 避免自动刷新竞态下旧响应覆盖新数据
let refreshGeneration = 0;

function updateAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (autoRefreshInterval.value > 0) {
    autoRefreshTimer = setInterval(() => {
      // 后台标签页不空转：页面不可见时跳过本轮自动刷新（G14-04）
      if (document.hidden) return;
      refreshAll();
    }, autoRefreshInterval.value);
  }
}

// Smart path truncation
function truncatePath(path: string, maxLength: number = 60): string {
  if (path.length <= maxLength) return path;
  const [pathname, query] = path.split('?');
  if (pathname.length > maxLength) {
    return pathname.substring(0, maxLength - 3) + '...';
  }
  if (query) {
    const available = maxLength - pathname.length - 1;
    if (available > 5) {
      return pathname + '?' + query.substring(0, available - 3) + '...';
    }
    return pathname + '?...';
  }
  return path;
}

// Table columns (fixed layout with controlled widths)
const columns = [
  { colKey: 'ip', title: 'IP 地址', width: 140 },
  { colKey: 'method', title: '方法', width: 70 },
  { colKey: 'path', title: '请求路径', ellipsis: false, width: 300 },
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

// Format time
function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Error rate level for color coding
function errorRateLevel(rate: number): string {
  if (rate >= 50) return 'critical';
  if (rate >= 10) return 'warning';
  return 'normal';
}

// Risk level theme mapping
function riskTheme(level: string): string {
  const map: Record<string, string> = {
    low: 'success',
    medium: 'warning',
    high: 'danger',
    critical: 'danger',
  };
  return map[level] || 'default';
}

// Risk level Chinese label
function riskLabel(level: string): string {
  const map: Record<string, string> = {
    low: '低',
    medium: '中',
    high: '高',
    critical: '严重',
  };
  return map[level] || level;
}

// Fetch stats
const statsErrorShown = ref(false);
async function fetchStats() {
  const gen = refreshGeneration;
  try {
    const { data } = await client.get('/admin/access-logs/stats', { params: { timeRange: timeRange.value } });
    if (gen !== refreshGeneration) return;
    const d = data.data || data;
    Object.assign(stats, d);
    statsErrorShown.value = false;
    await updatePieChart();
  } catch {
    if (gen !== refreshGeneration) return;
    if (!statsErrorShown.value) {
      statsErrorShown.value = true;
      MessagePlugin.error('加载访问统计数据失败');
    }
  }
}

/**
 * 趋势数据降采样（G14-08）：/trend 无粒度参数，30d 可能返回数千个数据点，
 * 前端按最大点数做等距抽样，保证图表渲染流畅。
 */
const TREND_MAX_POINTS = 400;
function downsampleTrend(items: TrendItem[]): TrendItem[] {
  if (items.length <= TREND_MAX_POINTS) return items;
  const step = items.length / TREND_MAX_POINTS;
  const sampled: TrendItem[] = [];
  for (let i = 0; i < TREND_MAX_POINTS; i++) {
    sampled.push(items[Math.min(items.length - 1, Math.floor(i * step))]);
  }
  return sampled;
}

// Fetch trend
const trendErrorShown = ref(false);
async function fetchTrend() {
  const gen = refreshGeneration;
  try {
    const { data } = await client.get('/admin/access-logs/trend', { params: { timeRange: timeRange.value } });
    if (gen !== refreshGeneration) return;
    const td = downsampleTrend((data.data || data) as TrendItem[]);
    trendData.value = td;
    trendErrorShown.value = false;
    await updateTrendChart(td);
  } catch {
    if (gen !== refreshGeneration) return;
    if (!trendErrorShown.value) {
      trendErrorShown.value = true;
      MessagePlugin.error('加载流量趋势失败');
    }
  }
}

// Fetch logs
async function fetchLogs() {
  const gen = refreshGeneration;
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
    if (gen !== refreshGeneration) return;
    const d = data.data || data;
    logs.value = d.items || [];
    total.value = d.total || 0;
    pagination.total = d.total || 0;
    pagination.current = currentPage.value;
    pagination.pageSize = pageSize.value;
  } catch {
    if (gen !== refreshGeneration) return;
    MessagePlugin.error('加载访问记录失败');
  } finally {
    if (gen === refreshGeneration) {
      loading.value = false;
    }
  }
}

// Fetch top files
async function fetchTopFiles() {
  const gen = refreshGeneration;
  topFilesLoading.value = true;
  try {
    const { data } = await client.get('/admin/access-logs/top-files', {
      params: {
        timeRange: timeRange.value,
        sortBy: topFilesSortBy.value,
        limit: 10,
      },
    });
    if (gen !== refreshGeneration) return;
    topFiles.value = (data.data || data) as TopFileItem[];
  } catch {
    if (gen !== refreshGeneration) return;
    topFiles.value = [];
  } finally {
    if (gen === refreshGeneration) {
      topFilesLoading.value = false;
    }
  }
}

// Fetch top paths
async function fetchTopPaths() {
  const gen = refreshGeneration;
  topPathsLoading.value = true;
  try {
    const { data } = await client.get('/admin/access-logs/top-paths', {
      params: {
        timeRange: timeRange.value,
        limit: 20,
      },
    });
    if (gen !== refreshGeneration) return;
    topPaths.value = (data.data || data) as TopPathItem[];
  } catch {
    if (gen !== refreshGeneration) return;
    topPaths.value = [];
  } finally {
    if (gen === refreshGeneration) {
      topPathsLoading.value = false;
    }
  }
}

// Fetch abnormal IPs
async function fetchAbnormalIps() {
  const gen = refreshGeneration;
  abnormalIpsLoading.value = true;
  try {
    const { data } = await client.get('/admin/access-logs/abnormal-ips', {
      params: {
        timeRange: timeRange.value,
        limit: 20,
        minRequests: 50,
      },
    });
    if (gen !== refreshGeneration) return;
    abnormalIps.value = (data.data || data) as AbnormalIpItem[];
  } catch {
    if (gen !== refreshGeneration) return;
    abnormalIps.value = [];
  } finally {
    if (gen === refreshGeneration) {
      abnormalIpsLoading.value = false;
    }
  }
}

// Ban an IP：打开封禁对话框（原因 + 时长），避免一键误封（G15-08）
function handleBanIp(ip: string) {
  banForm.ip = ip;
  banForm.reason = '';
  banForm.isPermanent = false;
  banForm.durationHours = 6;
  banDialogVisible.value = true;
}

// 封禁对话框状态
const banDialogVisible = ref(false);
const banDialogSaving = ref(false);
const banForm = reactive({
  ip: '',
  reason: '',
  isPermanent: false,
  durationHours: 6,
});

async function handleBanSubmit() {
  if (!banForm.ip) return;
  banDialogSaving.value = true;
  try {
    const payload: Record<string, unknown> = {
      ip: banForm.ip,
      permanent: banForm.isPermanent,
    };
    if (banForm.reason.trim()) payload.reason = banForm.reason.trim();
    if (!banForm.isPermanent) {
      payload.expiresAt = new Date(Date.now() + banForm.durationHours * 60 * 60 * 1000).toISOString();
    }
    await client.post('/admin/banned-ips', payload);
    const type = banForm.isPermanent ? '永久封禁' : `已封禁 ${banForm.durationHours} 小时`;
    MessagePlugin.success(`IP ${banForm.ip} ${type}`);
    banDialogVisible.value = false;
    abnormalIps.value = abnormalIps.value.filter((item) => item.ip !== banForm.ip);
  } catch {
    MessagePlugin.error(`封禁 IP ${banForm.ip} 失败`);
  } finally {
    banDialogSaving.value = false;
  }
}

// Trend chart
async function updateTrendChart(trendData: TrendItem[]) {
  if (!trendChartRef.value) return;

  await ensureCyberTheme();
  // 容器可能因 tab 切换被移除后重建，实例若已绑定到旧 DOM 必须重建，
  // 避免 setOption 写入已移除节点。用 getInstanceByDom 校验容器当前实例归属。
  const live = echarts.getInstanceByDom(trendChartRef.value);
  if (!trendChart || trendChart.isDisposed() || live !== trendChart) {
    trendChart?.dispose();
    trendChart = echarts.init(trendChartRef.value, 'cyber');
  }

  // 按时间范围动态格式化（G14-06）：7d/30d 跨度下仅 HH:mm 会丢失日期信息，
  // 短范围（1h/24h）用 HH:mm，长范围（7d/30d）用 MM-DD HH:mm
  const isLongRange = timeRange.value === '7d' || timeRange.value === '30d';
  const times = trendData.map((t) => {
    const d = new Date(t.time);
    return isLongRange
      ? d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  });

  trendChart.setOption({
    tooltip: {
      trigger: 'axis',
      ...tooltipBase,
    },
    legend: {
      data: ['请求数', '带宽'],
      ...legendBase,
      top: 0,
    },
    grid: { left: 50, right: 60, top: 30, bottom: 30 },
    xAxis: {
      type: 'category',
      data: times,
      axisLabel: { color: axisLabelColor(), fontSize: 11, rotate: trendData.length > 24 ? 45 : 0 },
      axisLine: { lineStyle: { color: axisLineColor() } },
    },
    yAxis: [
      {
        type: 'value',
        name: '请求数',
        nameTextStyle: { color: axisLabelColor(), fontSize: 11 },
        axisLabel: { color: axisLabelColor(), fontSize: 11 },
        splitLine: { lineStyle: { color: splitLineColor(), type: 'dashed' } },
      },
      {
        type: 'value',
        name: '带宽',
        nameTextStyle: { color: axisLabelColor(), fontSize: 11 },
        axisLabel: { color: axisLabelColor(), fontSize: 11, formatter: (v: number) => formatSizeUtil(v) },
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
        lineStyle: { color: CHART_COLORS.blue, width: 2 },
        areaStyle: { color: areaGradient(CHART_COLORS.blue) },
      },
      {
        name: '带宽',
        type: 'line',
        yAxisIndex: 1,
        data: trendData.map((t) => t.bandwidth),
        smooth: true,
        symbol: 'none',
        lineStyle: { color: CHART_COLORS.teal, width: 2 },
      },
    ],
  }, true);
  trendChart.resize();
}

// Pie chart
async function updatePieChart() {
  if (!pieChartRef.value) return;

  await ensureCyberTheme();
  const live = echarts.getInstanceByDom(pieChartRef.value);
  if (!pieChart || pieChart.isDisposed() || live !== pieChart) {
    pieChart?.dispose();
    pieChart = echarts.init(pieChartRef.value, 'cyber');
  }

  const dist = stats.statusDistribution || [];
  const pieData = dist.map((s) => ({
    name: s.statusCode.toString(),
    value: s.count,
    itemStyle: {
      color: s.statusCode < 300 ? STATUS_COLORS['2xx'] : s.statusCode < 400 ? STATUS_COLORS['3xx'] : s.statusCode < 500 ? STATUS_COLORS['4xx'] : STATUS_COLORS['5xx'],
    },
  }));

  pieChart.setOption({
    tooltip: {
      trigger: 'item',
      ...tooltipBase,
      formatter: (p: any) => `${p.name}: ${p.value} (${p.percent}%)`,
    },
    legend: {
      orient: 'vertical',
      right: 10,
      top: 'center',
      ...legendBase,
    },
    series: [
      {
        type: 'pie',
        radius: ['45%', '75%'],
        center: ['40%', '50%'],
        data: pieData.length > 0 ? pieData : [{ name: '无数据', value: 1, itemStyle: { color: isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(22,25,31,0.08)' } }],
        label: { show: false },
        emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' }, itemStyle: { shadowBlur: 20, shadowColor: isDark() ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.15)' } },
      },
    ],
  }, true);
  pieChart.resize();
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

// 整体刷新指示（G14-09）：刷新完成后才更新"最后更新"时间，避免时间戳超前于数据
const refreshing = ref(false);

async function refreshAll() {
  // 避免并发刷新叠加
  if (refreshing.value) return;
  refreshing.value = true;
  refreshGeneration++;
  // Promise.all 等待全部请求完成后统一写时间戳，保证"最后更新"与实际数据一致
  await Promise.allSettled([
    fetchStats(),
    fetchTrend(),
    fetchLogs(),
    fetchTopFiles(),
    fetchTopPaths(),
    fetchAbnormalIps(),
  ]);
  lastRefreshTime.value = new Date().toLocaleTimeString('zh-CN');
  refreshing.value = false;
}

// 切换到任意 tab 时触发对应子组件的图表 resize
const sourceAnalysisRef = ref<InstanceType<typeof SourceAnalysis> | null>(null);
const bandwidthRef = ref<InstanceType<typeof BandwidthAnalysis> | null>(null);
const fileTypeRef = ref<InstanceType<typeof FileTypeAnalysis> | null>(null);

watch(accessTab, (tab, prev) => {
  // 离开 overview 时其容器被 t-tabs 移除（destroyOnHide），主动 dispose 并置空实例，
  // 避免切回时复用写入已移除 DOM 的旧实例；getInstanceByDom 作为双保险。
  if (prev === 'overview' && tab !== 'overview') {
    trendChart?.dispose();
    trendChart = null;
    pieChart?.dispose();
    pieChart = null;
  }
  nextTick(() => {
    setTimeout(async () => {
      if (tab === 'source') {
        sourceAnalysisRef.value?.resizeAllCharts();
      } else if (tab === 'bandwidth') {
        bandwidthRef.value?.refreshChart();
      } else if (tab === 'filetypes') {
        fileTypeRef.value?.refreshChart();
      } else if (tab === 'overview') {
        if (trendData.value.length) await updateTrendChart(trendData.value);
        await updatePieChart();
      }
    }, 100);
  });
});

// Lifecycle
onMounted(() => {
  refreshAll();
});

onUnmounted(() => {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
  }
  trendChart?.dispose();
  pieChart?.dispose();
});

// Resize handler for ECharts on mobile
onMounted(() => window.addEventListener('resize', handleResize));
onUnmounted(() => window.removeEventListener('resize', handleResize));
</script>

<style scoped>
.access-logs-page {
  padding: 0;
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
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 20px;
}

.metric-label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.metric-value {
  font-family: var(--font-mono);
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
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

/* 卡片标题（.card 容器使用全局定义） */
.card h3 {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
}

/* Section card (new sections) */
.section-card {
  margin-bottom: 20px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.section-header h3 {
  margin: 0;
}

/* Table filters */
.table-filters {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

/* Path cell styles */
.path-cell {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.path-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
}

.path-info-icon {
  flex-shrink: 0;
  cursor: help;
  font-size: 13px;
  opacity: 0.6;
  transition: opacity 0.2s;
}

.path-info-icon:hover {
  opacity: 1;
}

/* Path truncation for new sections */
.path-truncate {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
  cursor: default;
}

/* Rank badge */
.rank-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--color-bg-hover);
}

.rank-badge.rank-1 {
  color: #ffd700;
  background: rgba(255, 215, 0, 0.15);
}

.rank-badge.rank-2 {
  color: #c0c0c0;
  background: rgba(192, 192, 192, 0.15);
}

.rank-badge.rank-3 {
  color: #cd7f32;
  background: rgba(205, 127, 50, 0.15);
}

/* File name cell */
.file-name-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.file-emoji {
  font-size: 14px;
  flex-shrink: 0;
}

/* IP code style */
.ip-code {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
  background: var(--color-bg-hover);
  padding: 2px 6px;
  border-radius: 3px;
}

/* Error rate color coding */
.error-rate-normal {
  color: var(--color-success);
}

.error-rate-warning {
  color: var(--color-warning);
}

.error-rate-critical {
  color: var(--color-danger);
  font-weight: 600;
}

/* Empty hint */
.empty-hint {
  text-align: center;
  padding: 24px 0;
  color: var(--text-secondary);
  font-size: 13px;
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

  .section-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
}

@media (max-width: 480px) {
  .metrics-grid {
    grid-template-columns: 1fr;
  }
}

/* Mobile access card */
.mobile-card-list {
  min-height: 100px;
}

.mobile-access-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 10px;
}

.mobile-access-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.mobile-access-ip {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-primary);
  background: var(--color-bg-hover);
  padding: 2px 6px;
  border-radius: 3px;
}

.mobile-access-path {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
  margin-bottom: 8px;
  line-height: 1.5;
}

.mobile-access-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-primary);
}
</style>
