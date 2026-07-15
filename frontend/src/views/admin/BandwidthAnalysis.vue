<template>
  <div class="bandwidth-page">
    <div class="page-header">
      <h1>带宽分析</h1>
      <p>带宽使用趋势与 Top 文件 / IP 排行</p>
    </div>

    <!-- Time Range Selector -->
    <div class="toolbar" :class="{ 'toolbar-row': isMobile }">
      <t-radio-group v-model="timeRange" variant="default-filled" @change="fetchData">
        <t-radio-button value="1h">1小时</t-radio-button>
        <t-radio-button value="24h">24小时</t-radio-button>
        <t-radio-button value="7d">7天</t-radio-button>
        <t-radio-button value="30d">30天</t-radio-button>
      </t-radio-group>
    </div>

    <t-loading :loading="loading" size="small">
      <template v-if="data">
        <!-- Bandwidth Trend Chart -->
        <div class="card">
          <h3>带宽趋势</h3>
          <div ref="chartRef" class="chart-container"></div>
        </div>

        <!-- Top Files by Bandwidth -->
        <div class="card">
          <h3>Top 文件带宽消耗</h3>
          <div v-if="!isMobile">
            <t-table
              :data="data.topFiles"
              :columns="fileColumns"
              row-key="fileId"
              table-layout="fixed"
              :pagination="false"
              size="small"
              max-height="400"
            >
              <template #rank="{ rowIndex }">
                <t-tag
                  :theme="rowIndex < 3 ? 'primary' : 'default'"
                  variant="light"
                  size="small"
                >
                  #{{ rowIndex + 1 }}
                </t-tag>
              </template>
              <template #fileName="{ row }">
                <span>{{ getFileEmoji(row.mimeType) }} {{ row.fileName }}</span>
              </template>
              <template #totalBandwidth="{ row }">
                {{ formatSize(Number(row.totalBandwidth)) }}
              </template>
            </t-table>
            <div v-if="!data.topFiles.length" class="empty-hint">暂无数据</div>
          </div>
          <div v-if="isMobile">
            <div v-for="(row, idx) in data.topFiles" :key="row.fileId" class="mobile-card">
              <div class="mobile-card-header">
                <t-tag
                  :theme="idx < 3 ? 'primary' : 'default'"
                  variant="light"
                  size="small"
                >
                  #{{ idx + 1 }}
                </t-tag>
                <span class="mobile-file-name">{{ getFileEmoji(row.mimeType) }} {{ row.fileName }}</span>
              </div>
              <div class="mobile-card-meta">
                <span>{{ row.mimeType }}</span>
                <span>{{ row.accessCount }}次</span>
                <span>{{ formatSize(Number(row.totalBandwidth)) }}</span>
              </div>
            </div>
            <div v-if="!data.topFiles.length" class="empty-hint">暂无数据</div>
          </div>
        </div>

        <!-- Top IPs by Bandwidth -->
        <div class="card">
          <h3>Top IP 带宽消耗</h3>
          <div v-if="!isMobile">
            <t-table
              :data="data.topIps"
              :columns="ipColumns"
              row-key="ip"
              table-layout="fixed"
              :pagination="false"
              size="small"
              max-height="400"
            >
              <template #bandwidth="{ row }">
                {{ formatSize(Number(row.bandwidth)) }}
              </template>
            </t-table>
            <div v-if="!data.topIps.length" class="empty-hint">暂无数据</div>
          </div>
          <div v-if="isMobile">
            <div v-for="row in data.topIps" :key="row.ip" class="mobile-card">
              <div class="mobile-card-header">{{ row.ip }}</div>
              <div class="mobile-card-meta">
                <span>带宽: {{ formatSize(Number(row.bandwidth)) }}</span>
                <span>{{ row.requestCount }}次</span>
              </div>
            </div>
            <div v-if="!data.topIps.length" class="empty-hint">暂无数据</div>
          </div>
        </div>
      </template>
      <div v-else-if="!loading" class="empty-hint">暂无数据</div>
    </t-loading>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import * as echarts from 'echarts';
import { api } from '@/stores/auth';
import { formatSize, getFileEmoji } from '@/utils/format';
import { useMobile } from '../../composables/useMobile';
import { CHART_COLORS, tooltipBase, areaGradient } from '../../utils/echarts-theme';

interface BandwidthResponse {
  topFiles: { fileId: string; fileName: string; mimeType: string; totalBandwidth: string; accessCount: number }[];
  topIps: { ip: string; bandwidth: string; requestCount: number }[];
  trend: { time: string; bandwidth: string }[];
}

const timeRange = ref('24h');
const loading = ref(false);
const data = ref<BandwidthResponse | null>(null);

const chartRef = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;
const isMobile = useMobile();

const fileColumns = [
  { colKey: 'rank', title: '排名', width: 70 },
  { colKey: 'fileName', title: '文件名', ellipsis: true },
  { colKey: 'mimeType', title: '类型', width: 100 },
  { colKey: 'accessCount', title: '访问次数', width: 100 },
  { colKey: 'totalBandwidth', title: '总带宽', width: 120 },
];

const ipColumns = [
  { colKey: 'ip', title: 'IP 地址', width: 160 },
  { colKey: 'bandwidth', title: '带宽消耗', width: 140 },
  { colKey: 'requestCount', title: '请求数', width: 100 },
];

const handleResize = () => {
  chart?.resize();
};

watch(isMobile, () => {
  nextTick(() => setTimeout(handleResize, 100));
});

function renderChart() {
  if (!chartRef.value) return;
  chart?.dispose();
  chart = echarts.init(chartRef.value, 'cyber');

  const trend = data.value?.trend || [];
  const times = trend.map((t) => t.time);
  const values = trend.map((t) => Number(t.bandwidth));

  chart.setOption({
    tooltip: {
      trigger: 'axis',
      ...tooltipBase,
      formatter: (params: unknown) => {
        const p = (params as { name: string; value: number; seriesName: string }[])[0];
        return `<b>${p.name}</b><br/>${p.seriesName}: ${formatSize(p.value)}`;
      },
    },
    grid: {
      left: '3%',
      right: '4%',
      bottom: '3%',
      top: '10',
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      data: times,
      boundaryGap: false,
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
      axisLabel: {
        color: '#8895A7',
        fontSize: 11,
        formatter: (val: string) => val.length > 16 ? val.substring(5) : val,
      },
    },
    yAxis: {
      type: 'value',
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
      axisLabel: {
        color: '#8895A7',
        fontSize: 11,
        formatter: (val: number) => formatSize(val),
      },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)', type: 'dashed' } },
    },
    series: [
      {
        name: '带宽',
        type: 'line',
        data: values,
        smooth: true,
        symbol: 'none',
        lineStyle: { color: CHART_COLORS.blue, width: 2 },
        areaStyle: { color: areaGradient(CHART_COLORS.blue) },
      },
    ],
  });
}

async function fetchData() {
  loading.value = true;
  try {
    const { data: res } = await api.get('/admin/bandwidth/top-files', {
      params: { timeRange: timeRange.value },
    });
    data.value = (res.data || res) as BandwidthResponse;
    await nextTick();
    renderChart();
  } catch {
    data.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  fetchData();
  window.addEventListener('resize', handleResize);
});

onUnmounted(() => {
  chart?.dispose();
  chart = null;
  window.removeEventListener('resize', handleResize);
});

function refreshChart() {
  nextTick(() => renderChart());
}

defineExpose({ refreshChart });
</script>

<style scoped>
.bandwidth-page {
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

/* Card */
.card {
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
}

.card h3 {
  font-size: 16px;
  font-weight: 500;
  margin: 0 0 16px;
}

/* Chart */
.chart-container {
  width: 100%;
  height: 320px;
}

/* Empty hint */
.empty-hint {
  text-align: center;
  padding: 24px 0;
  color: var(--text-secondary);
  font-size: 13px;
}

@media (max-width: 768px) {
  .toolbar-row {
    flex-direction: column;
    gap: 8px;
  }

  .mobile-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color, #333);
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 10px;
  }

  .mobile-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 14px;
  }

  .mobile-file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mobile-card-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 12px;
    color: var(--text-secondary);
  }
}
</style>
