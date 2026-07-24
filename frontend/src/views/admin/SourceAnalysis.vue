<template>
  <div class="source-analysis-page">
    <div class="page-header">
      <h1>来源分析</h1>
      <p>流量来源渠道与用户环境分析</p>
    </div>

    <!-- Time Range Selector -->
    <div class="toolbar">
      <t-radio-group v-model="timeRange" variant="default-filled" @change="onTimeRangeChange">
        <t-radio-button value="24h">24小时</t-radio-button>
        <t-radio-button value="7d">7天</t-radio-button>
        <t-radio-button value="30d">30天</t-radio-button>
      </t-radio-group>
    </div>

    <t-tabs v-model="activeTab" @change="onTabChange">
      <!-- Tab 1: 来源渠道 -->
      <t-tab-panel value="referer" label="来源渠道">
        <t-loading :loading="refererLoading" size="small">
          <div v-if="refererData" class="tab-content">
            <!-- Section A: 来源分类 -->
            <div class="card section-card">
              <h3>来源分类</h3>
              <div class="category-section">
                <div ref="refererCategoryChartRef" class="chart-container chart-pie"></div>
                <div class="category-cards">
                  <div
                    v-for="cat in refererData.categories"
                    :key="cat.name"
                    class="category-card-item"
                    :style="{ borderLeftColor: getCategoryColor(cat.name) }"
                  >
                    <div class="category-card-name">{{ cat.name }}</div>
                    <div class="category-card-count">{{ formatNumber(cat.count) }}</div>
                    <div class="category-card-pct">{{ cat.percentage.toFixed(1) }}%</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Section B: Top Referrers -->
            <div class="card section-card">
              <h3>Top Referrers</h3>
              <div v-if="!isMobile && topReferersWithPct.length > 0">
                <t-table
                  :data="topReferersWithPct"
                  :columns="refererColumns"
                  row-key="referer"
                  table-layout="fixed"
                  :pagination="false"
                  size="small"
                  max-height="400"
                >
                  <template #referer="{ row }">
                    <t-tooltip placement="top" :content="row.referer">
                      <span class="truncated-url">{{ row.referer }}</span>
                    </t-tooltip>
                  </template>
                </t-table>
              </div>
              <div v-if="isMobile && topReferersWithPct.length > 0" class="mobile-card-list">
                <div v-for="ref in topReferersWithPct" :key="ref.referer" class="mobile-card">
                  <div class="mobile-card-row">
                    <strong class="truncated-url">{{ ref.referer }}</strong>
                  </div>
                  <div class="mobile-card-meta">
                    <span>{{ ref.count }} 次</span>
                    <span>{{ ref.percentage }}</span>
                  </div>
                </div>
              </div>
              <div v-if="!refererData.topReferers.length" class="empty-hint">暂无数据</div>
            </div>

            <!-- Section C: 搜索关键词 -->
            <div
              v-if="refererData.topKeywords && refererData.topKeywords.length > 0"
              class="card section-card"
            >
              <h3>搜索关键词</h3>
              <div v-if="!isMobile">
                <t-table
                  :data="refererData.topKeywords"
                  :columns="keywordColumns"
                  row-key="keyword"
                  table-layout="fixed"
                  :pagination="false"
                  size="small"
                  max-height="400"
                >
                  <template #count="{ row }">
                    {{ formatNumber(row.count) }}
                  </template>
                </t-table>
              </div>
              <div v-if="isMobile" class="mobile-card-list">
                <div v-for="kw in refererData.topKeywords" :key="kw.keyword" class="mobile-card">
                  <div class="mobile-card-row">
                    <strong>{{ kw.keyword }}</strong>
                    <span>{{ formatNumber(kw.count) }} 次</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-else-if="!refererLoading" class="empty-hint">暂无来源数据</div>
        </t-loading>
      </t-tab-panel>

      <!-- Tab 2: 用户环境 -->
      <t-tab-panel value="ua" label="用户环境">
        <t-loading :loading="uaLoading" size="small">
          <div v-if="uaData" class="tab-content">
            <!-- Section A: 浏览器分布 -->
            <div class="section-card">
              <div class="section-title">浏览器分布</div>
              <div v-if="!isMobile && uaData.browsers.length > 0">
                <t-table
                  :data="uaData.browsers"
                  :columns="browserColumns"
                  row-key="name"
                  table-layout="fixed"
                  :pagination="false"
                  size="small"
                  max-height="300"
                >
                  <template #percentage="{ row }">
                    {{ row.percentage.toFixed(1) }}%
                  </template>
                </t-table>
              </div>
              <div v-if="isMobile && uaData.browsers.length > 0" class="mobile-card-list">
                <div v-for="b in uaData.browsers" :key="b.name + b.version" class="mobile-card">
                  <div class="mobile-card-row">
                    <strong>{{ b.name }}</strong>
                    <span>{{ b.percentage.toFixed(1) }}%</span>
                  </div>
                  <div class="mobile-card-meta">
                    <span>v{{ b.version }}</span>
                    <span>{{ b.count }} 次</span>
                  </div>
                </div>
              </div>
              <div v-if="!uaData.browsers.length" class="empty-hint">暂无浏览器数据</div>
            </div>

            <!-- Section B: 操作系统 -->
            <div class="section-card">
              <div class="section-title">操作系统</div>
              <div v-if="!isMobile && uaData.os.length > 0">
                <t-table
                  :data="uaData.os"
                  :columns="osColumns"
                  row-key="name"
                  table-layout="fixed"
                  :pagination="false"
                  size="small"
                  max-height="300"
                >
                  <template #percentage="{ row }">
                    {{ row.percentage.toFixed(1) }}%
                  </template>
                </t-table>
              </div>
              <div v-if="isMobile && uaData.os.length > 0" class="mobile-card-list">
                <div v-for="o in uaData.os" :key="o.name + o.version" class="mobile-card">
                  <div class="mobile-card-row">
                    <strong>{{ o.name }}</strong>
                    <span>{{ o.percentage.toFixed(1) }}%</span>
                  </div>
                  <div class="mobile-card-meta">
                    <span>v{{ o.version }}</span>
                    <span>{{ o.count }} 次</span>
                  </div>
                </div>
              </div>
              <div v-if="!uaData.os.length" class="empty-hint">暂无操作系统数据</div>
            </div>

            <!-- Section C: 设备类型 -->
            <div class="card section-card">
              <h3>设备类型</h3>
              <div class="device-section">
                <div ref="deviceChartRef" class="chart-container chart-pie"></div>
                <div class="device-cards">
                  <div
                    v-for="d in uaData.devices"
                    :key="d.type"
                    class="device-card-item"
                    :style="{ borderLeftColor: getDeviceColor(d.type) }"
                  >
                    <div class="device-card-name">{{ getDeviceLabel(d.type) }}</div>
                    <div class="device-card-count">{{ formatNumber(d.count) }}</div>
                    <div class="device-card-pct">{{ d.percentage.toFixed(1) }}%</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-else-if="!uaLoading" class="empty-hint">暂无用户环境数据</div>
        </t-loading>
      </t-tab-panel>
    </t-tabs>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import * as echarts from '@/utils/echarts';
import { api } from '@/stores/auth';
import { useMobile } from '../../composables/useMobile';
import { CHART_COLORS, tooltipBase, legendBase, ensureCyberTheme } from '../../utils/echarts-theme';

// Theme-aware chart colors
const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';

// --- Types ---

interface RefererCategory {
  name: string;
  count: number;
  percentage: number;
}

interface TopReferer {
  referer: string;
  count: number;
}

interface TopKeyword {
  keyword: string;
  count: number;
}

interface RefererAnalysisResponse {
  categories: RefererCategory[];
  topReferers: TopReferer[];
  topKeywords?: TopKeyword[];
}

interface BrowserItem {
  name: string;
  version: string;
  count: number;
  percentage: number;
}

interface OSItem {
  name: string;
  version: string;
  count: number;
  percentage: number;
}

interface DeviceItem {
  type: string;
  count: number;
  percentage: number;
}

interface UserAgentAnalysisResponse {
  browsers: BrowserItem[];
  os: OSItem[];
  devices: DeviceItem[];
  topUserAgents: { userAgent: string; count: number }[];
}

// --- State ---

const activeTab = ref('referer');
const timeRange = ref('7d');
const refererLoading = ref(false);
const uaLoading = ref(false);
const refererData = ref<RefererAnalysisResponse | null>(null);
const uaData = ref<UserAgentAnalysisResponse | null>(null);
const isMobile = useMobile();

// Top referers with computed percentage
const topReferersWithPct = computed(() => {
  const list = refererData.value?.topReferers || [];
  const total = list.reduce((s, r) => s + r.count, 0);
  return list.map((r) => ({
    ...r,
    percentage: total > 0 ? ((r.count / total) * 100).toFixed(1) + '%' : '0%',
  }));
});

// --- Columns ---

const refererColumns = [
  { colKey: 'referer', title: '来源', ellipsis: false, width: 400 },
  { colKey: 'count', title: '访问次数', width: 120 },
  { colKey: 'percentage', title: '占比', width: 100 },
];

const keywordColumns = [
  { colKey: 'keyword', title: '关键词', width: 300 },
  { colKey: 'count', title: '搜索次数', width: 120 },
];

const browserColumns = [
  { colKey: 'name', title: '浏览器', width: 150 },
  { colKey: 'version', title: '版本', width: 150 },
  { colKey: 'count', title: '数量', width: 100 },
  { colKey: 'percentage', title: '占比', width: 100 },
];

const osColumns = [
  { colKey: 'name', title: '操作系统', width: 150 },
  { colKey: 'version', title: '版本', width: 150 },
  { colKey: 'count', title: '数量', width: 100 },
  { colKey: 'percentage', title: '占比', width: 100 },
];

// --- Charts ---

const refererCategoryChartRef = ref<HTMLDivElement | null>(null);
const deviceChartRef = ref<HTMLDivElement | null>(null);

let refererCategoryChart: echarts.ECharts | null = null;
let deviceChart: echarts.ECharts | null = null;

// --- Colors ---

const CATEGORY_COLORS: Record<string, string> = {
  '引擎搜索': CHART_COLORS.blue,
  '社交媒体': CHART_COLORS.success,
  '直接访问': CHART_COLORS.warning,
  '本站内链': CHART_COLORS.danger,
  '外部网站': CHART_COLORS.cyan,
};

const deviceColorMap: Record<string, string> = {
  desktop: CHART_COLORS.teal,
  mobile: CHART_COLORS.blue,
  tablet: CHART_COLORS.amber,
  bot: CHART_COLORS.violet,
};

function getCategoryColor(name: string): string {
  return CATEGORY_COLORS[name] || CHART_COLORS.slate;
}

function getDeviceColor(type: string): string {
  return deviceColorMap[type] || CHART_COLORS.slate;
}

function getDeviceLabel(type: string): string {
  const map: Record<string, string> = {
    desktop: '桌面端',
    mobile: '移动端',
    tablet: '平板',
    bot: '机器人',
  };
  return map[type] || type;
}

// --- Chart Helpers ---

async function updatePieChart(
  chart: echarts.ECharts | null,
  el: HTMLDivElement | null,
  pieData: { name: string; value: number; color: string }[],
): Promise<echarts.ECharts | null> {
  if (!el) return chart;
  // 始终销毁重建，避免 display:none 导致的实例状态错乱
  await ensureCyberTheme();
  chart?.dispose();
  const c = echarts.init(el, 'cyber');
  c.setOption({
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
        data:
          pieData.length > 0
            ? pieData.map((d) => ({
                name: d.name,
                value: d.value,
                itemStyle: { color: d.color },
              }))
            : [{ name: '无数据', value: 1, itemStyle: { color: isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(22,25,31,0.08)' } }],
        label: { show: false },
        emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' }, itemStyle: { shadowBlur: 20, shadowColor: isDark() ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.15)' } },
      },
    ],
  });
  return c;
}

async function renderCategoryChart() {
  const el = refererCategoryChartRef.value;
  if (!el) return;
  const cats = refererData.value?.categories || [];
  refererCategoryChart = await updatePieChart(
    refererCategoryChart,
    el,
    cats.map((c) => ({
      name: c.name,
      value: c.count,
      color: getCategoryColor(c.name),
    })),
  );
}

async function renderDeviceChart() {
  const el = deviceChartRef.value;
  if (!el) return;
  const devices = uaData.value?.devices || [];
  deviceChart = await updatePieChart(
    deviceChart,
    el,
    devices.map((d) => ({
      name: getDeviceLabel(d.type),
      value: d.count,
      color: getDeviceColor(d.type),
    })),
  );
}

function resizeAllCharts() {
  refererCategoryChart?.resize();
  deviceChart?.resize();
}

// --- Data Fetching ---

async function fetchRefererData() {
  refererLoading.value = true;
  try {
    const { data } = await api.get('/admin/source-analysis/referer', {
      params: { timeRange: timeRange.value },
    });
    refererData.value = (data.data || data) as RefererAnalysisResponse;
    await nextTick();
    await renderCategoryChart();
  } catch {
    refererData.value = null;
  } finally {
    refererLoading.value = false;
  }
}

async function fetchUAData() {
  uaLoading.value = true;
  try {
    const { data } = await api.get('/admin/source-analysis/user-agent', {
      params: { timeRange: timeRange.value, topN: 500 },
    });
    uaData.value = (data.data || data) as UserAgentAnalysisResponse;
    await nextTick();
    await renderDeviceChart();
  } catch {
    uaData.value = null;
  } finally {
    uaLoading.value = false;
  }
}

// --- Event Handlers ---

function onTimeRangeChange() {
  fetchRefererData();
  fetchUAData();
}

function onTabChange() {
  nextTick(async () => {
    resizeAllCharts();
    if (activeTab.value === 'ua') {
      await renderDeviceChart();
    } else if (activeTab.value === 'referer') {
      await renderCategoryChart();
    }
  });
}

function fetchAll() {
  fetchRefererData();
  fetchUAData();
}

// --- Utils ---

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

// --- Lifecycle ---

const handleResize = () => { resizeAllCharts(); };

watch(isMobile, () => {
  nextTick(() => setTimeout(handleResize, 100));
});

onMounted(() => {
  fetchAll();
  window.addEventListener('resize', handleResize);
});

onUnmounted(() => {
  refererCategoryChart?.dispose();
  deviceChart?.dispose();
  window.removeEventListener('resize', handleResize);
});

defineExpose({ resizeAllCharts });
</script>

<style scoped>
.source-analysis-page {
  padding: 0;
}

.toolbar {
  margin-bottom: 20px;
}

.tab-content {
  padding-top: 16px;
}

/* Card */
.card {
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: 24px;
}

.card h3 {
  font-size: 16px;
  font-weight: 600;
  font-family: var(--font-display);
  margin: 0 0 16px;
}

/* Section card */
.section-card {
  margin-bottom: 20px;
}

.section-title {
  font-size: 16px;
  font-weight: 500;
  margin-bottom: 16px;
}

/* Category section: pie chart + cards side by side */
.category-section {
  display: flex;
  gap: 24px;
  align-items: flex-start;
}

.category-cards {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 200px;
}

.category-card-item {
  background: var(--color-bg-hover);
  border-left: 4px solid;
  border-radius: 4px;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  gap: 16px;
}

.category-card-name {
  flex: 1;
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 500;
}

.category-card-count {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
}

.category-card-pct {
  font-size: 13px;
  color: var(--text-secondary);
  min-width: 50px;
  text-align: right;
}

/* Device section */
.device-section {
  display: flex;
  gap: 24px;
  align-items: flex-start;
}

.device-cards {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 180px;
}

.device-card-item {
  background: var(--color-bg-hover);
  border-left: 4px solid;
  border-radius: 4px;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  gap: 16px;
}

.device-card-name {
  flex: 1;
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 500;
}

.device-card-count {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
}

.device-card-pct {
  font-size: 13px;
  color: var(--text-secondary);
  min-width: 50px;
  text-align: right;
}

/* Charts */
.charts-row {
  margin-bottom: 16px;
}

.chart-container {
  width: 100%;
  height: 320px;
}

.chart-pie {
  width: 100%;
  max-width: 450px;
}

/* Empty hint */
.empty-hint {
  text-align: center;
  padding: 24px 0;
  color: var(--text-secondary);
  font-size: 13px;
}

/* Truncated URL */
.truncated-url {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: default;
}

/* Responsive */
@media (max-width: 768px) {
  .category-section,
  .device-section {
    flex-direction: column;
  }

  .chart-pie {
    max-width: 100%;
  }

  .mobile-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 10px;
  }

  .mobile-card-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }

  .mobile-card-body {
    font-size: 13px;
    color: var(--text-secondary);
    margin-bottom: 8px;
    line-height: 1.5;
  }

  .mobile-card-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .mobile-single-col {
    grid-template-columns: 1fr !important;
  }
}
</style>
