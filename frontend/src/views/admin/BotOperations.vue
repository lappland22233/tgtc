<template>
  <div class="bot-operations">
    <header class="page-header ops-hero">
      <div class="ops-hero-copy">
        <h1>Bot 收件管理</h1>
        <p>Telegram 收件任务、直链签发与用户处置的统一运维台</p>
      </div>
      <div v-if="tab === 'overview'" class="ops-hero-tools">
        <label class="ops-range">统计范围
          <select v-model="range" @change="loadOverview">
            <option value="24h">近 24 小时</option>
            <option value="7d">近 7 天</option>
            <option value="30d">近 30 天</option>
          </select>
        </label>
        <button class="ops-btn" type="button" :disabled="overviewLoading" @click="loadOverview">刷新统计</button>
      </div>
    </header>

    <nav class="ops-tabs" aria-label="Bot 管理分区">
      <router-link v-for="item in tabs" :key="item.key" :to="{ path: '/admin/bot-operations', query: { tab: item.key } }"
        :aria-current="tab === item.key ? 'page' : undefined">{{ item.label }}</router-link>
    </nav>

    <template v-if="tab === 'overview'">
      <div class="ops-dashboard" :aria-busy="overviewLoading">
        <p v-if="overviewError" role="alert" class="ops-error">{{ overviewError }}</p>

        <section class="ops-kpis" aria-label="Bot 收件关键指标">
          <article class="ops-kpi">
            <span class="ops-kpi-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 13l2.5-7h11L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
                <path d="M4 13h5l1.5 2h3L15 13h5" />
              </svg>
            </span>
            <div class="ops-kpi-body">
              <span class="ops-kpi-label">收件任务</span>
              <strong class="ops-kpi-value">{{ overviewStats?.tasks ?? '—' }}</strong>
              <span class="ops-kpi-sub">{{ rangeLabel }} · 数据量 {{ overviewStats?.bytes ?? '—' }}</span>
            </div>
          </article>

          <article class="ops-kpi ops-kpi--warning">
            <span class="ops-kpi-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="8" />
                <path d="M12 8v4l3 2" />
              </svg>
            </span>
            <div class="ops-kpi-body">
              <span class="ops-kpi-label">当前积压</span>
              <strong class="ops-kpi-value">{{ overviewStats?.pending ?? '—' }}</strong>
              <span class="ops-kpi-sub">处理中 {{ overviewStats?.running ?? '—' }} · 实时快照</span>
            </div>
          </article>

          <article class="ops-kpi ops-kpi--success">
            <span class="ops-kpi-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="8" />
                <path d="M8.5 12.2l2.3 2.3 4.7-4.9" />
              </svg>
            </span>
            <div class="ops-kpi-body">
              <span class="ops-kpi-label">完成率</span>
              <strong class="ops-kpi-value">{{ overviewStats?.successRate ?? '—' }}</strong>
              <span class="ops-kpi-sub">完成 {{ overviewStats?.completed ?? '—' }} · 失败 {{ overviewStats?.failed ?? '—' }} · 取消 {{ overviewStats?.cancelled ?? '—' }}</span>
            </div>
          </article>

          <article class="ops-kpi">
            <span class="ops-kpi-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10 14a4 4 0 0 1 0-5.7l2.3-2.3a4 4 0 0 1 5.7 5.7L16.8 13" />
                <path d="M14 10a4 4 0 0 1 0 5.7l-2.3 2.3a4 4 0 0 1-5.7-5.7L7.2 11" />
              </svg>
            </span>
            <div class="ops-kpi-body">
              <span class="ops-kpi-label">有效直链</span>
              <strong class="ops-kpi-value">{{ overviewStats?.activeNow ?? '—' }}</strong>
              <span class="ops-kpi-sub">范围内签发 {{ overviewStats?.issued ?? '—' }} · 下载 {{ overviewStats?.downloads ?? '—' }} 次</span>
            </div>
          </article>
        </section>

        <div class="ops-charts">
          <section class="ops-card ops-chart ops-chart--wide">
            <header class="ops-chart-head">
              <h2>收件趋势</h2>
              <span class="ops-chart-hint">{{ trendHint }}</span>
            </header>
            <div v-if="hasTrend" ref="trendRef" class="ops-chart-canvas ops-chart-canvas--trend" role="img" :aria-label="trendSummary"></div>
            <p v-else-if="overviewLoading" class="ops-chart-empty" role="status">正在加载概览…</p>
            <p v-else class="ops-chart-empty">所选时间范围内暂无收件任务</p>
            <p v-if="hasTrend" class="ops-chart-summary">{{ trendSummary }}</p>
          </section>

          <section class="ops-card ops-chart">
            <header class="ops-chart-head">
              <h2>任务状态</h2>
              <span class="ops-chart-hint">总计 {{ overviewStats?.tasks ?? '—' }}</span>
            </header>
            <div v-if="hasStatus" ref="statusRef" class="ops-chart-canvas" role="img" :aria-label="statusSummary"></div>
            <p v-else-if="overviewLoading" class="ops-chart-empty" role="status">正在加载…</p>
            <p v-else class="ops-chart-empty">暂无任务数据</p>
            <p v-if="hasStatus" class="ops-chart-summary">{{ statusSummary }}</p>
          </section>

          <section class="ops-card ops-chart">
            <header class="ops-chart-head">
              <h2>直链状态</h2>
              <span class="ops-chart-hint">范围内签发 {{ overviewStats?.issued ?? '—' }}</span>
            </header>
            <div v-if="hasGrants" ref="grantRef" class="ops-chart-canvas" role="img" :aria-label="grantsSummary"></div>
            <p v-else-if="overviewLoading" class="ops-chart-empty" role="status">正在加载…</p>
            <p v-else class="ops-chart-empty">所选时间范围内暂无直链记录</p>
            <p v-if="hasGrants" class="ops-chart-summary">{{ grantsSummary }}</p>
          </section>

          <section class="ops-card ops-chart ops-chart--wide">
            <header class="ops-chart-head">
              <h2>收件 Bot 排行</h2>
              <span class="ops-chart-hint">Top 6 · 按范围内收件量排序</span>
            </header>
            <div v-if="hasBots" ref="botsRef" class="ops-chart-canvas" role="img" :aria-label="botsSummary"></div>
            <p v-else-if="overviewLoading" class="ops-chart-empty" role="status">正在加载…</p>
            <p v-else class="ops-chart-empty">暂无 Bot 收件记录</p>
            <p v-if="hasBots" class="ops-chart-summary">{{ botsSummary }}</p>
          </section>
        </div>
      </div>
    </template>

    <template v-else-if="userId">
      <div class="ops-detail-bar">
        <router-link :to="{ path: '/admin/bot-operations', query: { tab } }" class="ops-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14.5 6l-6 6 6 6" />
          </svg>
          返回用户列表
        </router-link>
        <span class="ops-detail-hint">正在查看 TG 用户 {{ userId }}</span>
      </div>
      <BotOperationsUser :key="tab + ':' + userId" :user-id="userId" :initial-kind="detailKind" />
    </template>
    <BotUserGroups v-else :key="tab" :scope="groupScope" :tab-key="groupTabKey" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  getOverview,
  type BotListKind,
  type BotOperationsOverview,
  type GrantStatus,
  type OverviewRange,
  type OverviewTrendRow,
  type QueueStatus,
  type UserGroupScope,
} from '@/api/bot-operations';
import { formatSize } from '@/utils/format';
import { getErrorMessage } from '@/utils/error';
import { useMobile } from '@/composables/useMobile';
import { useChartResize } from '@/composables/useChartResize';
import { useTheme } from '@/composables/useTheme';
import * as echarts from '@/utils/echarts';
import { CHART_COLORS, CHART_COLORS_DARK, ensureCyberTheme, legendBase } from '@/utils/echarts-theme';
import BotOperationsUser from './BotOperationsUser.vue';
import BotUserGroups from './BotUserGroups.vue';

type Palette = Record<keyof typeof CHART_COLORS, string>;

const tabs = [
  { key: 'overview', label: '概览' },
  { key: 'queue', label: '收件队列' },
  { key: 'grants', label: '直链管理' },
  { key: 'user', label: '用户审计' },
] as const;
type TabKey = typeof tabs[number]['key'];

const route = useRoute();
const tab = computed<TabKey>(() => {
  const value = route.query.tab;
  return value === 'queue' || value === 'grants' || value === 'user' ? value : 'overview';
});
const userId = computed(() => typeof route.query.telegramUserId === 'string' && /^\d+$/.test(route.query.telegramUserId) ? route.query.telegramUserId : '');
const groupScope = computed<UserGroupScope>(() => tab.value === 'grants' ? 'grants' : tab.value === 'user' ? 'audit' : 'queue');
const groupTabKey = computed<'queue' | 'grants' | 'user'>(() => tab.value === 'grants' ? 'grants' : tab.value === 'user' ? 'user' : 'queue');
const detailKind = computed<BotListKind>(() => tab.value === 'grants' ? 'grants' : tab.value === 'user' ? 'audit' : 'queue');

/* ---------------- 概览数据 ---------------- */

const range = ref<OverviewRange>('7d');
const overview = ref<BotOperationsOverview | null>(null);
const overviewLoading = ref(false);
const overviewError = ref('');
let overviewRequest: AbortController | undefined;
let disposed = false;

const rangeLabel = computed(() => range.value === '24h' ? '近 24 小时' : range.value === '30d' ? '近 30 天' : '近 7 天');

const overviewStats = computed(() => {
  const data = overview.value;
  if (!data) return null;
  return {
    tasks: formatNumber(data.queue.total),
    bytes: formatSize(data.queue.bytes),
    pending: formatNumber(data.queue.pending),
    running: formatNumber(data.queue.running),
    successRate: data.queue.successRate === null ? '—' : Math.round(data.queue.successRate * 100) + '%',
    completed: formatNumber(data.queue.byStatus.completed),
    failed: formatNumber(data.queue.byStatus.failed),
    cancelled: formatNumber(data.queue.byStatus.cancelled),
    activeNow: formatNumber(data.grants.activeNow),
    issued: formatNumber(data.grants.total),
    downloads: formatNumber(data.grants.downloads),
  };
});

const hasTrend = computed(() => (overview.value?.trend.length ?? 0) > 0);
const hasStatus = computed(() => (overview.value?.queue.total ?? 0) > 0);
const hasGrants = computed(() => (overview.value?.grants.total ?? 0) > 0);
const hasBots = computed(() => (overview.value?.topBots.length ?? 0) > 0);

const statusOrder: QueueStatus[] = ['completed', 'failed', 'cancelled', 'running', 'queued'];
const statusLabels: Record<QueueStatus, string> = {
  queued: '待处理', running: '处理中', completed: '已完成', failed: '失败', cancelled: '已取消',
};
const grantOrder: GrantStatus[] = ['active', 'expired', 'revoked'];
const grantLabels: Record<GrantStatus, string> = { active: '有效', expired: '已到期', revoked: '已撤销' };

const isMobile = useMobile();
const MAX_CHART_BUCKETS_DESKTOP = 40;
const MAX_CHART_BUCKETS_MOBILE = 12;
const COLLAPSE_STEPS = [1, 2, 3, 4, 6, 8, 12, 24];

function pickCollapseStep(bucketCount: number, maxBuckets: number): number {
  if (bucketCount <= maxBuckets) return 1;
  return COLLAPSE_STEPS.find(step => Math.ceil(bucketCount / step) <= maxBuckets) ?? Math.ceil(bucketCount / maxBuckets);
}

const TREND_RANGE_MS: Record<OverviewRange, number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
};

const trendUnitMs = computed(() => overview.value?.timeRange === '30d' ? 86_400_000 : 3_600_000);

/**
 * 后端只返回有数据的时间桶。先按真实时间戳补齐空桶，再做合并，
 * 避免空闲时段两侧的桶被误并进同一个「每 N 小时」区间。
 */
const filledTrend = computed<OverviewTrendRow[]>(() => {
  const data = overview.value;
  if (!data || data.trend.length === 0) return [];
  const unitMs = trendUnitMs.value;
  const times = data.trend
    .map(row => new Date(row.bucket).getTime())
    .filter(time => Number.isFinite(time))
    .sort((a, b) => a - b);
  if (times.length === 0) return data.trend;
  const origin = times[0];
  const generatedAt = new Date(data.generatedAt).getTime();
  const rangeStart = generatedAt - TREND_RANGE_MS[data.timeRange];
  const leading = Number.isFinite(rangeStart) ? Math.max(0, Math.ceil((origin - rangeStart) / unitMs)) : 0;
  const lastKnown = times[times.length - 1];
  const end = Number.isFinite(generatedAt) ? Math.max(generatedAt, lastKnown) : lastKnown;
  const trailing = Math.max(0, Math.floor((end - origin) / unitMs));
  const slots: OverviewTrendRow[] = Array.from({ length: leading + trailing + 1 }, (_, index) => ({
    bucket: new Date(origin + (index - leading) * unitMs).toISOString(),
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    total: 0,
  }));
  for (const row of data.trend) {
    const time = new Date(row.bucket).getTime();
    if (!Number.isFinite(time)) continue;
    const index = Math.round((time - origin) / unitMs) + leading;
    const slot = slots[index];
    if (!slot) continue;
    slot.queued += row.queued;
    slot.running += row.running;
    slot.completed += row.completed;
    slot.failed += row.failed;
    slot.cancelled += row.cancelled;
    slot.total += row.total;
  }
  return slots;
});

const collapseStep = computed(() => pickCollapseStep(filledTrend.value.length, isMobile.value ? MAX_CHART_BUCKETS_MOBILE : MAX_CHART_BUCKETS_DESKTOP));

const chartTrend = computed<OverviewTrendRow[]>(() => {
  const rows = filledTrend.value;
  const step = collapseStep.value;
  if (step <= 1) return rows;
  const collapsed: OverviewTrendRow[] = [];
  for (let start = 0; start < rows.length; start += step) {
    const chunk = rows.slice(start, start + step);
    collapsed.push({
      bucket: chunk[0].bucket,
      queued: chunk.reduce((sum, row) => sum + row.queued, 0),
      running: chunk.reduce((sum, row) => sum + row.running, 0),
      completed: chunk.reduce((sum, row) => sum + row.completed, 0),
      failed: chunk.reduce((sum, row) => sum + row.failed, 0),
      cancelled: chunk.reduce((sum, row) => sum + row.cancelled, 0),
      total: chunk.reduce((sum, row) => sum + row.total, 0),
    });
  }
  return collapsed;
});

const trendHint = computed(() => {
  if (!hasTrend.value) return '';
  const unit = range.value === '30d' ? '天' : '小时';
  return collapseStep.value > 1 ? `粒度：每 ${collapseStep.value} ${unit}` : `粒度：按${unit}`;
});

const trendSummary = computed(() => {
  const rows = chartTrend.value;
  if (!rows.length) return '';
  const peak = rows.reduce((max, row) => Math.max(max, row.total), 0);
  return `区间内共 ${formatNumber(overview.value?.queue.total ?? 0)} 个收件任务，单时段峰值 ${formatNumber(peak)} 个。`;
});

const statusSummary = computed(() => {
  const by = overview.value?.queue.byStatus;
  if (!by) return '';
  return `已完成 ${formatNumber(by.completed)}，失败 ${formatNumber(by.failed)}，已取消 ${formatNumber(by.cancelled)}，待处理 ${formatNumber(by.queued)}，处理中 ${formatNumber(by.running)}。`;
});

const grantsSummary = computed(() => {
  const grants = overview.value?.grants;
  if (!grants) return '';
  return `范围内签发 ${formatNumber(grants.total)} 条：有效 ${formatNumber(grants.byStatus.active)}，已到期 ${formatNumber(grants.byStatus.expired)}，已撤销 ${formatNumber(grants.byStatus.revoked)}；累计下载 ${formatNumber(grants.downloads)} 次。`;
});

const botsSummary = computed(() => {
  const bots = overview.value?.topBots ?? [];
  if (!bots.length) return '';
  const total = bots.reduce((sum, bot) => sum + bot.total, 0);
  const failed = bots.reduce((sum, bot) => sum + bot.failed, 0);
  return `Top ${bots.length} 收件 Bot 共处理 ${formatNumber(total)} 个任务，其中失败 ${formatNumber(failed)} 个。`;
});

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + 'M';
  if (value >= 1_000) return (value / 1_000).toFixed(1) + 'K';
  return String(value);
}

function formatBucket(bucket: string): string {
  const date = new Date(bucket);
  if (Number.isNaN(date.getTime())) return bucket;
  if (range.value === '30d') return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  if (range.value === '7d') return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit' });
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

async function loadOverview() {
  overviewRequest?.abort();
  const request = new AbortController();
  overviewRequest = request;
  overviewLoading.value = true;
  overviewError.value = '';
  try {
    const data = await getOverview(range.value, request.signal);
    if (request.signal.aborted || disposed) return;
    overview.value = data;
    await nextTick();
    if (!request.signal.aborted && !disposed) await renderCharts();
  } catch (err) {
    if (!request.signal.aborted && !disposed) {
      overview.value = null;
      overviewError.value = getErrorMessage(err);
      disposeCharts();
    }
  } finally {
    if (!request.signal.aborted && !disposed) overviewLoading.value = false;
  }
}

/* ---------------- 图表 ---------------- */

const trendRef = ref<HTMLDivElement | null>(null);
const statusRef = ref<HTMLDivElement | null>(null);
const grantRef = ref<HTMLDivElement | null>(null);
const botsRef = ref<HTMLDivElement | null>(null);
let trendChart: echarts.ECharts | null = null;
let statusChart: echarts.ECharts | null = null;
let grantChart: echarts.ECharts | null = null;
let botsChart: echarts.ECharts | null = null;
let renderToken = 0;

const { isDark } = useTheme();

function readCssToken(token: string): string {
  if (typeof getComputedStyle !== 'function') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

const mutedText = () => readCssToken('--workspace-muted');

/** canvas 不解析 CSS 变量，这里读取令牌的实际值后再交给 ECharts。 */
function tooltipStyle() {
  return {
    backgroundColor: readCssToken('--workspace-surface'),
    borderColor: readCssToken('--workspace-border'),
    borderWidth: 1,
    textStyle: { color: readCssToken('--workspace-text'), fontSize: 12 },
    extraCssText: 'border-radius: 4px; box-shadow: var(--shadow-md);',
  };
}

function disposeCharts() {
  trendChart?.dispose();
  trendChart = null;
  statusChart?.dispose();
  statusChart = null;
  grantChart?.dispose();
  grantChart = null;
  botsChart?.dispose();
  botsChart = null;
}

function trendFormatter(params: unknown) {
  const list = (Array.isArray(params) ? params : [params]) as { axisValue: string; seriesName: string; value: number | string }[];
  if (!list.length) return '';
  const total = list.reduce((sum, item) => sum + Number(item.value || 0), 0);
  const lines = list.filter(item => Number(item.value) > 0).map(item => `${item.seriesName}：${formatNumber(Number(item.value))}`);
  return `${list[0].axisValue}<br/>${(lines.length ? lines : ['无收件']).join('<br/>')}<br/>合计：${formatNumber(total)}`;
}

function pieFormatter(params: unknown) {
  const item = (Array.isArray(params) ? params[0] : params) as { name: string; value: number; percent?: number };
  return `${item.name}：${formatNumber(Number(item.value ?? 0))} 条（${item.percent ?? 0}%）`;
}

function botsFormatter(params: unknown) {
  const list = (Array.isArray(params) ? params : [params]) as { axisValue: string; seriesName: string; value: number; dataIndex: number }[];
  if (!list.length) return '';
  const bot = overview.value?.topBots[list[0].dataIndex];
  const lines = list.map(item => `${item.seriesName}：${formatNumber(Number(item.value ?? 0))}`);
  return `Bot ${bot?.receiverBotId ?? list[0].axisValue}<br/>${lines.join('<br/>')}${bot ? `<br/>数据量：${formatSize(bot.bytes)}` : ''}`;
}

function renderTrend(palette: Palette) {
  const rows = chartTrend.value;
  const el = trendRef.value;
  if (!el || !rows.length) return;
  const muted = mutedText();
  const colors: Record<QueueStatus, string> = {
    queued: palette.warning, running: palette.primary, completed: palette.success, failed: palette.danger, cancelled: palette.slate,
  };
  trendChart = echarts.init(el, 'cloudscape');
  trendChart.setOption({
    tooltip: { trigger: 'axis', ...tooltipStyle(), formatter: trendFormatter },
    legend: { data: statusOrder.map(status => statusLabels[status]), ...legendBase, top: 0, textStyle: { color: muted, fontSize: 11 } },
    grid: { left: 44, right: 16, top: 38, bottom: 6 },
    xAxis: {
      type: 'category', data: rows.map(row => formatBucket(row.bucket)),
      axisTick: { show: false }, axisLabel: { fontSize: 11, color: muted, hideOverlap: true },
    },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 11, color: muted } },
    series: statusOrder.map(status => ({
      name: statusLabels[status], type: 'bar', stack: 'tasks', barMaxWidth: 22,
      itemStyle: { color: colors[status] }, data: rows.map(row => row[status]),
    })),
  }, true);
  trendChart.resize();
}

function renderStatus(palette: Palette) {
  const data = overview.value;
  const el = statusRef.value;
  if (!el || !data) return;
  const muted = mutedText();
  const colors: Record<QueueStatus, string> = {
    queued: palette.warning, running: palette.primary, completed: palette.success, failed: palette.danger, cancelled: palette.slate,
  };
  const entries = statusOrder
    .map(status => ({ name: statusLabels[status], value: data.queue.byStatus[status], itemStyle: { color: colors[status] } }))
    .filter(entry => entry.value > 0);
  if (!entries.length) return;
  statusChart = echarts.init(el, 'cloudscape');
  statusChart.setOption({
    tooltip: { trigger: 'item', ...tooltipStyle(), formatter: pieFormatter },
    legend: { ...legendBase, bottom: 0, left: 'center', textStyle: { color: muted, fontSize: 11 } },
    series: [{
      type: 'pie', radius: ['46%', '70%'], center: ['50%', '42%'], avoidLabelOverlap: true,
      label: { show: false }, labelLine: { show: false }, data: entries,
    }],
  }, true);
  statusChart.resize();
}

function renderGrants(palette: Palette) {
  const data = overview.value;
  const el = grantRef.value;
  if (!el || !data) return;
  const muted = mutedText();
  const colors: Record<GrantStatus, string> = { active: palette.success, expired: palette.slate, revoked: palette.danger };
  const entries = grantOrder
    .map(status => ({ name: grantLabels[status], value: data.grants.byStatus[status], itemStyle: { color: colors[status] } }))
    .filter(entry => entry.value > 0);
  if (!entries.length) return;
  grantChart = echarts.init(el, 'cloudscape');
  grantChart.setOption({
    tooltip: { trigger: 'item', ...tooltipStyle(), formatter: pieFormatter },
    legend: { ...legendBase, bottom: 0, left: 'center', textStyle: { color: muted, fontSize: 11 } },
    series: [{
      type: 'pie', radius: ['46%', '70%'], center: ['50%', '42%'], avoidLabelOverlap: true,
      label: { show: false }, labelLine: { show: false }, data: entries,
    }],
  }, true);
  grantChart.resize();
}

function renderBots(palette: Palette) {
  const bots = overview.value?.topBots ?? [];
  const el = botsRef.value;
  if (!el || !bots.length) return;
  const muted = mutedText();
  botsChart = echarts.init(el, 'cloudscape');
  botsChart.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...tooltipStyle(), formatter: botsFormatter },
    legend: { data: ['收件任务', '失败'], ...legendBase, top: 0, textStyle: { color: muted, fontSize: 11 } },
    grid: { left: 96, right: 40, top: 34, bottom: 6 },
    xAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 11, color: muted } },
    yAxis: {
      type: 'category', inverse: true, data: bots.map(bot => bot.receiverBotId),
      axisTick: { show: false }, axisLabel: { fontSize: 11, color: muted, width: 88, overflow: 'truncate' },
    },
    series: [
      {
        name: '收件任务', type: 'bar', barMaxWidth: 11,
        itemStyle: { color: palette.primary, borderRadius: [0, 2, 2, 0] },
        label: { show: true, position: 'right', fontSize: 11, color: muted, formatter: '{c}' },
        data: bots.map(bot => bot.total),
      },
      {
        name: '失败', type: 'bar', barMaxWidth: 11,
        itemStyle: { color: palette.danger, borderRadius: [0, 2, 2, 0] },
        data: bots.map(bot => bot.failed),
      },
    ],
  }, true);
  botsChart.resize();
}

async function renderCharts() {
  const token = ++renderToken;
  if (tab.value !== 'overview') return;
  disposeCharts();
  if (!overview.value) return;
  await ensureCyberTheme();
  if (token !== renderToken || tab.value !== 'overview' || disposed) return;
  const palette = isDark.value ? CHART_COLORS_DARK : CHART_COLORS;
  renderTrend(palette);
  renderStatus(palette);
  renderGrants(palette);
  renderBots(palette);
}

useChartResize(() => {
  trendChart?.resize();
  statusChart?.resize();
  grantChart?.resize();
  botsChart?.resize();
});

watch(isMobile, () => {
  nextTick(() => { if (tab.value === 'overview') void renderCharts(); });
});

watch(isDark, () => {
  if (tab.value === 'overview') void renderCharts();
});

watch(tab, async next => {
  if (next !== 'overview') { disposeCharts(); return; }
  await nextTick();
  await loadOverview();
});

onMounted(() => {
  if (tab.value === 'overview') void loadOverview();
});

onBeforeUnmount(() => {
  disposed = true;
  overviewRequest?.abort();
  disposeCharts();
});
</script>

<style scoped>
.bot-operations {
  display: grid;
  gap: 16px;
  min-width: 0;
  color: var(--text-primary);
}

.bot-operations :deep(:is(.ops-user, .ops-list)) {
  display: grid;
  gap: 16px;
  min-width: 0;
}

.bot-operations :deep(:is(h1, h2, h3, p, dl, dd)) {
  margin: 0;
}

.bot-operations :deep(h2) {
  font-size: 18px;
}

.bot-operations :deep(h3) {
  font-size: 16px;
  overflow-wrap: anywhere;
}

/* ---------- 页头与工具区 ---------- */
.bot-operations :deep(.ops-hero) {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 0;
}

.bot-operations :deep(.ops-hero-copy) {
  min-width: 0;
}

.bot-operations :deep(.ops-hero-tools) {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  width: 100%;
}

.bot-operations :deep(.ops-range) {
  flex: 1 1 160px;
  width: auto;
}

/* ---------- 通用控件 ---------- */
.bot-operations :deep(:is(.ops-tabs, .ops-actions, .ops-list-head, .ops-pages, .ops-row header)) {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.bot-operations :deep(:is(.ops-list-head, .ops-pages, .ops-row header)) {
  justify-content: space-between;
}

.bot-operations :deep(:is(.ops-btn, .ops-tabs a, .ops-tabs button)) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 6px 12px;
  font: inherit;
  color: var(--text-primary);
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-decoration: none;
}

.bot-operations :deep(:is(.ops-tabs [aria-current="page"], .ops-tabs [aria-pressed="true"], .ops-btn.primary)) {
  color: var(--workspace-accent);
  border-color: var(--border-accent);
  background: var(--color-bg-selected);
}

.bot-operations :deep(:is(.ops-btn.danger, .ops-error)) {
  color: var(--color-danger);
}

.bot-operations :deep(button:disabled) {
  color: var(--text-disabled);
  cursor: default;
}

.bot-operations :deep(:is(.ops-form, .ops-row, .ops-confirm, .ops-summary)) {
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 16px;
  min-width: 0;
}

.bot-operations :deep(.ops-form) {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr));
  gap: 12px;
  align-items: end;
}

.bot-operations :deep(label) {
  display: grid;
  gap: 4px;
  min-width: 0;
  color: var(--text-secondary);
}

.bot-operations :deep(:is(input, select, textarea)) {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 44px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--text-primary);
  font: inherit;
  padding: 6px 8px;
}

.bot-operations :deep(:is(.ops-row, .ops-confirm, .ops-quota)) {
  display: grid;
  gap: 12px;
  overflow-wrap: anywhere;
}

.bot-operations :deep(.ops-quota) {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 12px 14px;
}

.bot-operations :deep(.ops-quota__title) {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.bot-operations :deep(.ops-quota label) {
  display: grid;
  gap: 6px;
}

.bot-operations :deep(.ops-quota input) {
  max-width: 220px;
}

.bot-operations :deep(:is(.ops-details, .ops-summary)) {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
  gap: 8px 16px;
}

.bot-operations :deep(:is(.ops-details div, .ops-summary div)) {
  min-width: 0;
  overflow-wrap: anywhere;
}

.bot-operations :deep(:is(dt, .ops-empty, .ops-pages)) {
  color: var(--text-secondary);
}

.bot-operations :deep(dd) {
  margin-top: 3px;
}

.bot-operations :deep(dd a) {
  color: var(--workspace-accent);
  text-decoration: underline;
}

.bot-operations :deep(.ops-status) {
  padding: 3px 8px;
  color: var(--color-success);
  background: var(--color-success-soft);
  border-radius: var(--radius-sm);
}

.bot-operations :deep(.ops-status.muted) {
  color: var(--text-secondary);
  background: var(--color-bg-elevated);
}

/* ---------- 用户分类列表与用户详情 ---------- */
.bot-operations :deep(.ops-groups) {
  display: grid;
  gap: 16px;
  min-width: 0;
}

.bot-operations :deep(.ops-group-heading) {
  min-width: 0;
}

.bot-operations :deep(.ops-group-hint) {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.bot-operations :deep(.ops-group-row) {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  min-width: 0;
  padding: 14px 16px;
  color: inherit;
  text-decoration: none;
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}

.bot-operations :deep(.ops-group-row:hover) {
  border-color: var(--border-strong);
  background: var(--color-bg-hover);
}

.bot-operations :deep(.ops-group-row:focus-visible) {
  outline: 2px solid var(--border-accent);
  outline-offset: 2px;
}

.bot-operations :deep(.ops-group-avatar) {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--color-accent-soft);
  color: var(--text-accent);
  font-family: var(--font-mono);
  font-weight: 600;
}

.bot-operations :deep(.ops-group-main) {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.bot-operations :deep(.ops-group-head) {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.bot-operations :deep(.ops-group-id) {
  font-family: var(--font-mono);
  font-size: 14px;
  overflow-wrap: anywhere;
}

.bot-operations :deep(.ops-group-name) {
  font-size: 12px;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.bot-operations :deep(.ops-group-name.muted) {
  color: var(--text-tertiary);
}

.bot-operations :deep(.ops-group-chips) {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.bot-operations :deep(.ops-chip) {
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--color-bg-elevated);
}

.bot-operations :deep(.ops-chip.success) {
  color: var(--color-success);
  background: var(--color-success-soft);
}

.bot-operations :deep(.ops-chip.danger) {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

.bot-operations :deep(.ops-chip.warning) {
  color: var(--color-warning);
  background: var(--color-warning-soft);
}

.bot-operations :deep(.ops-chip.accent) {
  color: var(--text-accent);
  background: var(--color-accent-soft);
}

.bot-operations :deep(.ops-group-side) {
  grid-column: 2;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  justify-items: start;
  min-width: 0;
  text-align: left;
}

.bot-operations :deep(.ops-group-metric) {
  font-family: var(--font-mono);
  font-size: 14px;
  color: var(--text-primary);
  white-space: nowrap;
}

.bot-operations :deep(:is(.ops-group-size, .ops-group-time)) {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.bot-operations :deep(.ops-group-cta) {
  font-size: 12px;
  color: var(--workspace-accent);
  white-space: nowrap;
}

.bot-operations :deep(.ops-detail-bar) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.bot-operations :deep(.ops-detail-bar .ops-btn) {
  display: inline-flex;
  gap: 4px;
}

.bot-operations :deep(.ops-detail-bar svg) {
  width: 18px;
  height: 18px;
}

.bot-operations :deep(.ops-detail-hint) {
  font-size: 12px;
  color: var(--text-secondary);
}

/* ---------- 概览：KPI ---------- */
.bot-operations :deep(.ops-dashboard) {
  display: grid;
  gap: 16px;
  min-width: 0;
}

.bot-operations :deep(.ops-kpis) {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: 12px;
}

.bot-operations :deep(.ops-kpi) {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  min-width: 0;
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}

.bot-operations :deep(.ops-kpi-icon) {
  display: grid;
  place-items: center;
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
  color: var(--text-accent);
}

.bot-operations :deep(.ops-kpi-icon svg) {
  width: 22px;
  height: 22px;
}

.bot-operations :deep(.ops-kpi--warning .ops-kpi-icon) {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.bot-operations :deep(.ops-kpi--success .ops-kpi-icon) {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.bot-operations :deep(.ops-kpi-body) {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.bot-operations :deep(.ops-kpi-label) {
  font-size: 12px;
  color: var(--text-secondary);
}

.bot-operations :deep(.ops-kpi-value) {
  font-family: var(--font-mono);
  font-size: 20px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.bot-operations :deep(.ops-kpi-sub) {
  font-size: 12px;
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}

/* ---------- 概览：图表 ---------- */
.bot-operations :deep(.ops-charts) {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}

.bot-operations :deep(.ops-card) {
  display: grid;
  gap: 8px;
  align-content: start;
  min-width: 0;
  padding: 16px;
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}

.bot-operations :deep(.ops-chart-head) {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.bot-operations :deep(.ops-chart-head h2) {
  font-size: 16px;
}

.bot-operations :deep(.ops-chart-hint) {
  font-size: 12px;
  color: var(--text-secondary);
}

.bot-operations :deep(.ops-chart-canvas),
.bot-operations :deep(.ops-chart-canvas--trend) {
  width: 100%;
  height: 220px;
  min-width: 0;
}

.bot-operations :deep(.ops-chart-summary) {
  font-size: 12px;
  color: var(--text-secondary);
}

.bot-operations :deep(.ops-chart-empty) {
  padding: 28px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-secondary);
}

@media (min-width: 769px) {
  .bot-operations :deep(.ops-hero-tools) {
    width: auto;
  }

  .bot-operations :deep(.ops-range) {
    flex: none;
    width: 160px;
  }

  .bot-operations :deep(.ops-group-row) {
    grid-template-columns: 40px minmax(0, 1fr) auto;
  }

  .bot-operations :deep(.ops-group-side) {
    grid-column: auto;
    display: grid;
    justify-items: end;
    gap: 2px;
    text-align: right;
  }

  .bot-operations :deep(.ops-charts) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .bot-operations :deep(.ops-chart--wide) {
    grid-column: 1 / -1;
  }

  .bot-operations :deep(.ops-chart-canvas) {
    height: 238px;
  }

  .bot-operations :deep(.ops-chart-canvas--trend) {
    height: 260px;
  }

  .bot-operations :deep(.ops-kpi-value) {
    font-size: 24px;
  }
}
</style>
