<template>
  <div class="bot-usage-page">
    <div class="page-header">
      <h1>Bot 使用</h1>
      <p>Telegram Bot 收到文件、直链下载量、去重用户与带宽消耗（收到文件来自直链签发记录，下载来自访问日志）</p>
    </div>

    <!-- Time Range Selector -->
    <div class="toolbar">
      <t-radio-group v-model="timeRange" variant="default-filled" @change="fetchData">
        <t-radio-button value="1h">1小时</t-radio-button>
        <t-radio-button value="24h">24小时</t-radio-button>
        <t-radio-button value="7d">7天</t-radio-button>
        <t-radio-button value="30d">30天</t-radio-button>
      </t-radio-group>
      <span v-if="lastRefreshTime" class="toolbar-hint">最后更新：{{ lastRefreshTime }}</span>
    </div>

    <t-loading :loading="loading" size="small">
      <!-- 指标概览（图标 + 数值） -->
      <div class="metrics-grid">
        <div class="metric-card">
          <span class="metric-icon">
            <!-- 文件纸张图标：避免用上下箭头（易与「上传/下载」混淆） -->
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
              <path d="M14 3v5h5" />
              <path d="M9 13h6" />
              <path d="M9 17h4" />
            </svg>
          </span>
          <div class="metric-body">
            <div class="metric-label">收到文件</div>
            <div class="metric-value">{{ formatNumber(summary.filesReceived) }}</div>
            <div class="metric-sub">共 {{ formatSize(Number(summary.receivedBytes)) }}</div>
          </div>
        </div>

        <div class="metric-card">
          <span class="metric-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 4v10" />
              <path d="M8 11l4 4 4-4" />
              <path d="M5 19h14" />
            </svg>
          </span>
          <div class="metric-body">
            <div class="metric-label">下载次数</div>
            <div class="metric-value">{{ formatNumber(summary.downloads) }}</div>
            <div class="metric-sub">Bot 直链成功下载</div>
          </div>
        </div>

        <div class="metric-card">
          <span class="metric-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="9" cy="8" r="3" />
              <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
              <path d="M16 5.5a3 3 0 0 1 0 5.8" />
              <path d="M18 20v-1.6a4.4 4.4 0 0 0-1.4-3.2" />
            </svg>
          </span>
          <div class="metric-body">
            <div class="metric-label">去重用户</div>
            <div class="metric-value">{{ formatNumber(summary.uniqueUsers) }}</div>
            <div class="metric-sub">按 Telegram 用户 ID 去重</div>
          </div>
        </div>

        <div class="metric-card">
          <span class="metric-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M7 20V6" />
              <path d="M4 9l3-3 3 3" />
              <path d="M17 4v14" />
              <path d="M14 15l3 3 3-3" />
            </svg>
          </span>
          <div class="metric-body">
            <div class="metric-label">总带宽</div>
            <div class="metric-value">{{ formatSize(Number(summary.totalBytes)) }}</div>
            <div class="metric-sub">直链累计传输流量</div>
          </div>
        </div>

        <div class="metric-card">
          <span class="metric-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 20h16" />
              <rect x="6" y="12" width="3" height="8" rx="1" />
              <rect x="11" y="8" width="3" height="12" rx="1" />
              <rect x="16" y="5" width="3" height="15" rx="1" />
            </svg>
          </span>
          <div class="metric-body">
            <div class="metric-label">峰值时段</div>
            <div class="metric-value">{{ formatNumber(peakDownloads) }}</div>
            <div class="metric-sub">单个时间桶最高下载</div>
          </div>
        </div>
      </div>

      <!-- 趋势图：拆成两张共享时间轴的单一量纲图（避免双轴 + 多序列导致的误读） -->
      <div class="card chart-card">
        <div class="chart-header">
          <h3>使用趋势</h3>
          <span v-if="summary.trend.length > 0" class="chart-hint">{{ granularityHint }}</span>
        </div>

        <template v-if="summary.trend.length > 0">
          <div ref="volumeChartRef" class="chart-container chart-container--volume"></div>
          <div ref="bandwidthChartRef" class="chart-container chart-container--bandwidth"></div>
        </template>
        <div v-else-if="!loading" class="empty-hint">所选时间范围内暂无 Bot 直链记录</div>
      </div>

      <!-- 明细表 -->
      <div class="card">
        <h3>时段明细</h3>
        <div v-if="!isMobile">
          <t-table
            :data="trendRowsDesc"
            :columns="detailColumns"
            row-key="bucket"
            table-layout="fixed"
            :pagination="false"
            size="small"
            max-height="420"
          >
            <template #files="{ row }">
              {{ formatNumber(row.files) }}
            </template>
            <template #fileBytes="{ row }">
              {{ formatSize(Number(row.fileBytes)) }}
            </template>
            <template #downloads="{ row }">
              {{ formatNumber(row.downloads) }}
            </template>
            <template #bytes="{ row }">
              {{ formatSize(Number(row.bytes)) }}
            </template>
          </t-table>
        </div>
        <div v-else class="mobile-card-list">
          <div v-for="row in trendRowsDesc" :key="row.bucket" class="mobile-detail-card">
            <div class="mobile-detail-time">{{ formatBucket(row.bucket) }}</div>
            <div class="mobile-detail-meta">
              <span>收到 {{ formatNumber(row.files) }}（{{ formatSize(Number(row.fileBytes)) }}）</span>
            </div>
            <div class="mobile-detail-meta">
              <span>下载 {{ formatNumber(row.downloads) }}</span>
              <span>{{ formatSize(Number(row.bytes)) }}</span>
            </div>
          </div>
        </div>
        <div v-if="!loading && summary.trend.length === 0" class="empty-hint">暂无数据</div>
      </div>

      <!-- 用户明细：直接查看 TG 用户 ID 与 @用户名（不是昵称），支持筛选 -->
      <div class="card">
        <div class="section-header">
          <h3>用户明细</h3>
          <span class="section-hint">按 TG 用户 ID 聚合；「被下载」为该用户文件直链的累计访问次数，不受上方时间范围影响</span>
        </div>
        <div class="table-filters">
          <t-input
            v-model="userKeyword"
            class="filter-input"
            placeholder="搜索 TG 用户 ID 或 @用户名..."
            clearable
            autocomplete="off"
            name="bot-user-keyword"
            @enter="onUserFilterChange"
            @clear="onUserFilterChange"
          />
          <t-select v-model="userTimeRange" class="filter-select" @change="onUserFilterChange">
            <t-option value="all" label="全部时间" />
            <t-option value="24h" label="近 24 小时" />
            <t-option value="7d" label="近 7 天" />
            <t-option value="30d" label="近 30 天" />
          </t-select>
          <t-button variant="outline" :loading="usersLoading" @click="fetchUsers">查询</t-button>
        </div>

        <t-table
          v-if="!isMobile"
          :data="users"
          :columns="userColumns"
          :loading="usersLoading"
          :pagination="userPagination"
          row-key="telegramUserId"
          table-layout="fixed"
          @page-change="onUserPageChange"
        >
          <template #telegramUserId="{ row }">
            <code class="user-id-cell">{{ row.telegramUserId }}</code>
          </template>
          <template #telegramUsername="{ row }">
            <span v-if="row.telegramUsername" class="username-cell">{{ row.telegramUsername }}</span>
            <span v-else class="muted-cell">未设置用户名</span>
          </template>
          <template #filesReceived="{ row }">
            {{ formatNumber(row.filesReceived) }}
          </template>
          <template #receivedBytes="{ row }">
            {{ formatSize(Number(row.receivedBytes)) }}
          </template>
          <template #downloads="{ row }">
            {{ formatNumber(row.downloads) }}
          </template>
          <template #lastReceivedAt="{ row }">
            {{ formatDateTime(row.lastReceivedAt) }}
          </template>
        </t-table>

        <div v-else class="mobile-card-list">
          <div v-for="row in users" :key="row.telegramUserId" class="mobile-user-card">
            <div class="mobile-user-header">
              <code class="user-id-cell">{{ row.telegramUserId }}</code>
              <span v-if="row.telegramUsername" class="username-cell">{{ row.telegramUsername }}</span>
              <span v-else class="muted-cell">未设置用户名</span>
            </div>
            <div class="mobile-detail-meta">
              <span>收到 {{ formatNumber(row.filesReceived) }}</span>
              <span>{{ formatSize(Number(row.receivedBytes)) }}</span>
              <span>被下载 {{ formatNumber(row.downloads) }}</span>
            </div>
            <div class="mobile-user-time">最近收到：{{ formatDateTime(row.lastReceivedAt) }}</div>
          </div>
          <div v-if="users.length > 0" class="mobile-pagination">
            <t-pagination
              :current="userPagination.current"
              :total="userPagination.total"
              :page-size="userPagination.pageSize"
              size="small"
              @change="onUserPageChange"
            />
          </div>
        </div>

        <div v-if="!usersLoading && users.length === 0" class="empty-hint">没有匹配的 TG 用户</div>
      </div>
    </t-loading>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import * as echarts from '@/utils/echarts';
import client from '../../api/client';
import { formatSize } from '@/utils/format';
import { useMobile } from '../../composables/useMobile';
import {
  CHART_COLORS,
  tooltipBase,
  legendBase,
  areaGradient,
  ensureCyberTheme,
} from '../../utils/echarts-theme';

interface BotUsageTrendRow {
  bucket: string;
  downloads: number;
  bytes: string;
  files: number;
  fileBytes: string;
}

interface BotUsageSummary {
  timeRange: string;
  downloads: number;
  uniqueUsers: number;
  totalBytes: string;
  filesReceived: number;
  receivedBytes: string;
  trend: BotUsageTrendRow[];
}

interface BotUserRow {
  telegramUserId: string;
  /** @用户名快照（不是昵称；用户未设置时为 null） */
  telegramUsername: string | null;
  filesReceived: number;
  receivedBytes: string;
  downloads: number;
  lastReceivedAt: string | null;
  lastAccessedAt: string | null;
}

const timeRange = ref('7d');
const loading = ref(false);
const lastRefreshTime = ref('');
const summary = ref<BotUsageSummary>({
  timeRange: '7d',
  downloads: 0,
  uniqueUsers: 0,
  totalBytes: '0',
  filesReceived: 0,
  receivedBytes: '0',
  trend: [],
});

const volumeChartRef = ref<HTMLDivElement | null>(null);
const bandwidthChartRef = ref<HTMLDivElement | null>(null);
let volumeChart: echarts.ECharts | null = null;
let bandwidthChart: echarts.ECharts | null = null;
const isMobile = useMobile();

const detailColumns = [
  { colKey: 'bucket', title: '时间', width: 180 },
  { colKey: 'files', title: '收到文件', width: 100 },
  { colKey: 'fileBytes', title: '收到大小', width: 110 },
  { colKey: 'downloads', title: '下载次数', width: 110 },
  { colKey: 'bytes', title: '带宽', width: 110 },
];

// ---------------- 用户明细（TG 用户 ID + @用户名） ----------------

const users = ref<BotUserRow[]>([]);
const usersLoading = ref(false);
const userKeyword = ref('');
const userTimeRange = ref('all');
const userPagination = reactive({
  current: 1,
  pageSize: 20,
  total: 0,
  showJumper: true,
  pageSizeOptions: [10, 20, 50],
});

const userColumns = [
  { colKey: 'telegramUserId', title: 'TG 用户 ID', width: 200 },
  { colKey: 'telegramUsername', title: '用户名', width: 160 },
  { colKey: 'filesReceived', title: '收到文件', width: 100 },
  { colKey: 'receivedBytes', title: '收到大小', width: 110 },
  { colKey: 'downloads', title: '被下载', width: 90 },
  { colKey: 'lastReceivedAt', title: '最近收到', width: 170 },
];

/** 峰值时段：单个时间桶内的最高下载次数（各时间范围下都有意义） */
const peakDownloads = computed(() =>
  summary.value.trend.reduce((max, row) => Math.max(max, Number(row.downloads) || 0), 0),
);

/** 明细表按时间倒序，最近时段在前 */
const trendRowsDesc = computed(() => [...summary.value.trend].reverse());

/**
 * 图表桶上限：后端按「1h→分钟、24h/7d→小时、30d→天」出桶，7 天范围会有 168 个小时桶，
 * 逐桶画柱会细到无法辨认；超过上限时把相邻桶合并（求和）后再画。
 * 时段明细表仍保留后端原始粒度，图表只做显示层降采样。
 */
const MAX_CHART_BUCKETS_DESKTOP = 40;
const MAX_CHART_BUCKETS_MOBILE = 20;

/** 原始桶的粒度单位（与后端 getUsageSummary 的 bucketUnit 对齐） */
const rawBucketUnit = computed(() => (timeRange.value === '1h' ? '分钟' : timeRange.value === '30d' ? '天' : '小时'));

/** 合并步长优先取自然刻度，使合并后的标签落在整点/整天上（「每 6 小时」优于「每 5 小时」） */
const COLLAPSE_STEPS = [1, 2, 3, 4, 6, 8, 12, 24];

function pickCollapseStep(bucketCount: number, maxBuckets: number): number {
  if (bucketCount <= maxBuckets) return 1;
  return COLLAPSE_STEPS.find((step) => Math.ceil(bucketCount / step) <= maxBuckets)
    ?? Math.ceil(bucketCount / maxBuckets);
}

const maxChartBuckets = computed(() => (isMobile.value ? MAX_CHART_BUCKETS_MOBILE : MAX_CHART_BUCKETS_DESKTOP));
const collapseStep = computed(() => pickCollapseStep(summary.value.trend.length, maxChartBuckets.value));

/** 合并相邻桶（求和），桶标签取区间起点；单桶值均为小量级，JS 侧累加无精度风险 */
const chartRows = computed<BotUsageTrendRow[]>(() => {
  const rows = summary.value.trend;
  const step = collapseStep.value;
  if (step <= 1) return rows;
  const collapsed: BotUsageTrendRow[] = [];
  for (let start = 0; start < rows.length; start += step) {
    const chunk = rows.slice(start, start + step);
    collapsed.push({
      bucket: chunk[0].bucket,
      downloads: chunk.reduce((total, row) => total + row.downloads, 0),
      files: chunk.reduce((total, row) => total + row.files, 0),
      bytes: String(chunk.reduce((total, row) => total + Number(row.bytes), 0)),
      fileBytes: String(chunk.reduce((total, row) => total + Number(row.fileBytes), 0)),
    });
  }
  return collapsed;
});

/** 图表粒度说明（合并后必须显式标注，避免与明细表的原始粒度混淆） */
const granularityHint = computed(() =>
  summary.value.trend.length === 0 ? '' : `粒度：每 ${collapseStep.value} ${rawBucketUnit.value}`);

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

/** 用户明细的时间列：空值显示占位符 */
function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 按时间范围选择刻度格式：短范围到分钟，长范围带日期 */
function formatBucket(bucket: string): string {
  const d = new Date(bucket);
  if (Number.isNaN(d.getTime())) return bucket;
  if (timeRange.value === '1h' || timeRange.value === '24h') {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  if (timeRange.value === '7d') {
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

const handleResize = () => {
  volumeChart?.resize();
  bandwidthChart?.resize();
};

// 移动端会改用更少的桶（见 chartRows），因此不能只 resize，必须整图重绘
watch(isMobile, () => {
  nextTick(() => setTimeout(() => { void renderCharts(); }, 100));
});

/** 两张图共用的网格与坐标轴基线，保证上下时间轴严格对齐（小倍数图） */
const CHART_GRID = { left: 60, right: 20 };

/** x 轴刻度：不旋转（旋转标签会显著降低可读性），重叠时由 ECharts 自动抽稀 */
const categoryAxisBase = {
  type: 'category' as const,
  boundaryGap: true,
  axisTick: { show: false },
  axisLabel: { fontSize: 11, hideOverlap: true },
};

/** 统一的轴提示格式化：带宽按大小、其余按次数 */
const axisTooltipFormatter = (params: unknown) => {
  const list = (Array.isArray(params) ? params : [params]) as {
    axisValue: string;
    seriesName: string;
    value: number;
  }[];
  if (list.length === 0) return '';
  const lines = list.map((item) =>
    item.seriesName === '带宽'
      ? `${item.seriesName}：${formatSize(Number(item.value))}`
      : `${item.seriesName}：${formatNumber(Number(item.value))} 次`,
  );
  return `${list[0].axisValue}<br/>${lines.join('<br/>')}`;
};

/**
 * 渲染两张单一量纲的小倍数图：
 * - 上：收到文件 / 下载次数（分组柱，同为「次数」，单一 y 轴）；
 * - 下：带宽（面积折线，独立 y 轴但不再与次数共享画布）。
 * 二者共用 `CHART_GRID` 与同一批桶，上下对照即可读出「同一时间的收发量 vs 流量」。
 */
async function renderCharts() {
  const rows = chartRows.value;
  if (rows.length === 0) {
    volumeChart?.dispose();
    volumeChart = null;
    bandwidthChart?.dispose();
    bandwidthChart = null;
    return;
  }
  await ensureCyberTheme();

  const labels = rows.map((row) => formatBucket(row.bucket));
  const tooltip = { trigger: 'axis' as const, ...tooltipBase, formatter: axisTooltipFormatter };
  // 柱体过密时限制单柱宽度，保证相邻柱之间有可辨识的间隙
  const barStyle = { barMaxWidth: 16, barGap: '18%', barCategoryGap: '38%' };

  // 容器在 tab 切换/重建后归属可能变化，统一 dispose 后重建，避免写入已移除节点
  if (volumeChartRef.value) {
    volumeChart?.dispose();
    volumeChart = echarts.init(volumeChartRef.value, 'cyber');
    volumeChart.setOption({
      tooltip,
      legend: { data: ['收到文件', '下载次数'], ...legendBase, top: 0 },
      grid: { ...CHART_GRID, top: 26, bottom: 4 },
      xAxis: { ...categoryAxisBase, data: labels, axisLabel: { show: false } },
      yAxis: {
        type: 'value',
        name: '次数',
        nameTextStyle: { fontSize: 11 },
        minInterval: 1,
        axisLabel: { fontSize: 11 },
      },
      series: [
        {
          name: '收到文件',
          type: 'bar',
          ...barStyle,
          data: rows.map((row) => row.files),
          itemStyle: { color: CHART_COLORS.success, borderRadius: [2, 2, 0, 0] },
        },
        {
          name: '下载次数',
          type: 'bar',
          ...barStyle,
          data: rows.map((row) => row.downloads),
          itemStyle: { color: CHART_COLORS.primary, borderRadius: [2, 2, 0, 0] },
        },
      ],
    }, true);
    volumeChart.resize();
  }

  if (bandwidthChartRef.value) {
    bandwidthChart?.dispose();
    bandwidthChart = echarts.init(bandwidthChartRef.value, 'cyber');
    bandwidthChart.setOption({
      tooltip,
      grid: { ...CHART_GRID, top: 26, bottom: 22 },
      xAxis: { ...categoryAxisBase, data: labels },
      yAxis: {
        type: 'value',
        name: '带宽',
        nameTextStyle: { fontSize: 11 },
        axisLabel: { fontSize: 11, formatter: (value: number) => formatSize(value) },
      },
      series: [
        {
          name: '带宽',
          type: 'line',
          data: rows.map((row) => Number(row.bytes)),
          smooth: true,
          symbol: 'none',
          lineStyle: { color: CHART_COLORS.teal, width: 2 },
          areaStyle: { color: areaGradient(CHART_COLORS.teal) },
        },
      ],
    }, true);
    bandwidthChart.resize();
  }
}

async function fetchData() {
  loading.value = true;
  try {
    const { data } = await client.get('/admin/bot-usage', {
      params: { timeRange: timeRange.value },
    });
    const d = (data.data || data) as Partial<BotUsageSummary> | null;
    summary.value = {
      timeRange: String(d?.timeRange ?? timeRange.value),
      downloads: Number(d?.downloads ?? 0),
      uniqueUsers: Number(d?.uniqueUsers ?? 0),
      totalBytes: String(d?.totalBytes ?? '0'),
      filesReceived: Number(d?.filesReceived ?? 0),
      receivedBytes: String(d?.receivedBytes ?? '0'),
      trend: Array.isArray(d?.trend)
        ? d.trend.map((row) => ({
            bucket: String(row.bucket),
            downloads: Number(row.downloads ?? 0),
            bytes: String(row.bytes ?? '0'),
            files: Number(row.files ?? 0),
            fileBytes: String(row.fileBytes ?? '0'),
          }))
        : [],
    };
    lastRefreshTime.value = new Date().toLocaleTimeString('zh-CN');
    await nextTick();
    await renderCharts();
  } catch {
    summary.value = {
      timeRange: timeRange.value,
      downloads: 0,
      uniqueUsers: 0,
      totalBytes: '0',
      filesReceived: 0,
      receivedBytes: '0',
      trend: [],
    };
    await nextTick();
    await renderCharts();
  } finally {
    loading.value = false;
  }
}

/** 用户明细查询（关键字 + 时间范围 + 分页，全部服务端过滤） */
async function fetchUsers() {
  usersLoading.value = true;
  try {
    const params: Record<string, unknown> = {
      page: userPagination.current,
      pageSize: userPagination.pageSize,
      timeRange: userTimeRange.value,
    };
    if (userKeyword.value.trim()) params.keyword = userKeyword.value.trim();

    const { data } = await client.get('/admin/bot-usage/users', { params });
    const d = (data.data || data) as { total?: number; rows?: BotUserRow[] } | null;
    users.value = Array.isArray(d?.rows)
      ? d.rows.map((row) => ({
          telegramUserId: String(row.telegramUserId),
          telegramUsername: row.telegramUsername ? String(row.telegramUsername) : null,
          filesReceived: Number(row.filesReceived ?? 0),
          receivedBytes: String(row.receivedBytes ?? '0'),
          downloads: Number(row.downloads ?? 0),
          lastReceivedAt: row.lastReceivedAt ? String(row.lastReceivedAt) : null,
          lastAccessedAt: row.lastAccessedAt ? String(row.lastAccessedAt) : null,
        }))
      : [];
    userPagination.total = Number(d?.total ?? 0);
  } catch {
    users.value = [];
    userPagination.total = 0;
  } finally {
    usersLoading.value = false;
  }
}

function onUserFilterChange() {
  userPagination.current = 1;
  fetchUsers();
}

function onUserPageChange(pageInfo: { current: number; pageSize: number }) {
  userPagination.current = pageInfo.current;
  userPagination.pageSize = pageInfo.pageSize;
  fetchUsers();
}

/** 切换到本 tab 时由父组件调用：容器刚从隐藏变为可见，需重绘并重新测量尺寸 */
function refreshChart() {
  nextTick(async () => {
    await renderCharts();
  });
}

defineExpose({ refreshChart });

onMounted(() => {
  fetchData();
  fetchUsers();
  window.addEventListener('resize', handleResize);
});

onUnmounted(() => {
  volumeChart?.dispose();
  volumeChart = null;
  bandwidthChart?.dispose();
  bandwidthChart = null;
  window.removeEventListener('resize', handleResize);
});
</script>

<style scoped>
.bot-usage-page {
  padding: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.toolbar-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-left: auto;
}

/* Metrics */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.metric-card {
  display: flex;
  align-items: center;
  gap: 14px;
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 18px;
}

.metric-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
  color: var(--text-accent);
}

.metric-icon svg {
  width: 22px;
  height: 22px;
}

.metric-body {
  min-width: 0;
}

.metric-label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.metric-value {
  font-family: var(--font-mono);
  font-size: 26px;
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.metric-sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
}

/* Card */
.card {
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: 20px;
  margin-bottom: 20px;
}

.card h3 {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 16px;
}

/* 用户明细 */
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.section-header h3 {
  margin: 0;
}

.section-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.table-filters {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
  align-items: center;
}

.filter-input {
  width: 260px;
}

.filter-select {
  width: 150px;
}

.user-id-cell {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
  background: var(--color-bg-hover);
  padding: 2px 6px;
  border-radius: 3px;
}

.username-cell {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
}

.muted-cell {
  font-size: 12px;
  color: var(--text-secondary);
}

.mobile-user-card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 12px;
  margin-bottom: 10px;
}

.mobile-user-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.mobile-user-time {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

.mobile-pagination {
  display: flex;
  justify-content: center;
  margin-top: 12px;
}

.chart-card {
  min-height: 0;
}

.chart-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.chart-header h3 {
  margin: 0;
}

.chart-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.chart-container {
  width: 100%;
}

/* 上：收到文件 / 下载次数（隐藏 x 轴标签）；下：带宽（承载 x 轴标签）。
   两图 grid 左右留白一致，上下对齐形成小倍数图，共读同一条时间轴。 */
.chart-container--volume {
  height: 220px;
}

.chart-container--bandwidth {
  height: 150px;
}

.empty-hint {
  text-align: center;
  padding: 24px 0;
  color: var(--text-secondary);
  font-size: 13px;
}

/* Mobile detail cards */
.mobile-card-list {
  min-height: 60px;
}

.mobile-detail-card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 12px;
  margin-bottom: 10px;
}

.mobile-detail-time {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
  margin-bottom: 6px;
}

.mobile-detail-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-secondary);
}

@media (max-width: 768px) {
  .metric-value {
    font-size: 22px;
  }

  .chart-container--volume {
    height: 180px;
  }

  .chart-container--bandwidth {
    height: 130px;
  }

  .filter-input,
  .filter-select {
    width: 100%;
  }
}
</style>
