<template>
  <div class="bandwidth-page">
    <div class="page-header">
      <h1>带宽分析</h1>
      <p>带宽使用趋势与 Top 文件 / IP 排行</p>
    </div>

    <!-- Time Range Selector -->
    <div class="toolbar">
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

        <!-- Top IPs by Bandwidth -->
        <div class="card">
          <h3>Top IP 带宽消耗</h3>
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
      </template>
      <div v-else-if="!loading" class="empty-hint">暂无数据</div>
    </t-loading>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import * as echarts from 'echarts';
import { api } from '@/stores/auth';
import { formatSize, getFileEmoji } from '@/utils/format';

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

function renderChart() {
  if (!chartRef.value) return;
  chart?.dispose();
  chart = echarts.init(chartRef.value, 'dark');

  const trend = data.value?.trend || [];
  const times = trend.map((t) => t.time);
  const values = trend.map((t) => Number(t.bandwidth));

  chart.setOption({
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(30,30,30,0.9)',
      borderColor: '#444',
      textStyle: { color: '#eee' },
      formatter: (params: unknown) => {
        const p = (params as { name: string; value: number; seriesName: string }[])[0];
        return `${p.name}<br/>${p.seriesName}: ${formatSize(p.value)}`;
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
      axisLine: { lineStyle: { color: '#555' } },
      axisLabel: {
        color: '#aaa',
        fontSize: 11,
        formatter: (val: string) => {
          // Shorten time label
          if (val.length > 16) return val.substring(5);
          return val;
        },
      },
    },
    yAxis: {
      type: 'value',
      axisLine: { lineStyle: { color: '#555' } },
      axisLabel: {
        color: '#aaa',
        fontSize: 11,
        formatter: (val: number) => formatSize(val),
      },
      splitLine: { lineStyle: { color: '#333' } },
    },
    series: [
      {
        name: '带宽',
        type: 'line',
        data: values,
        smooth: true,
        symbol: 'none',
        lineStyle: {
          color: '#5470c6',
          width: 2,
        },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(84, 112, 198, 0.35)' },
            { offset: 1, color: 'rgba(84, 112, 198, 0.02)' },
          ]),
        },
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
});

onUnmounted(() => {
  chart?.dispose();
  chart = null;
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
</style>
