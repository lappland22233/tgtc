<template>
  <div class="file-type-page">
    <div class="page-header">
      <h1>文件类型</h1>
      <p>文件类型分布统计与容量分析</p>
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
        <div class="charts-row">
          <!-- Pie Chart -->
          <div class="card" style="flex: 1; min-width: 340px;">
            <h3>文件类型分布</h3>
            <div ref="chartRef" class="chart-container"></div>
          </div>

          <!-- File Type Table -->
          <div class="card" style="flex: 1; min-width: 340px;">
            <h3>类型详情</h3>
            <t-table
              :data="data.categories"
              :columns="typeColumns"
              row-key="name"
              table-layout="fixed"
              :pagination="false"
              size="small"
            >
              <template #name="{ row }">
                <t-tag
                  :style="{ background: getColor(row.name), borderColor: getColor(row.name) }"
                  variant="light"
                  size="small"
                >
                  {{ getLabel(row.name) }}
                </t-tag>
              </template>
              <template #totalSize="{ row }">
                {{ formatSize(Number(row.totalSize)) }}
              </template>
              <template #percentage="{ row }">
                {{ row.percentage.toFixed(1) }}%
              </template>
            </t-table>
            <div v-if="!data.categories.length" class="empty-hint">暂无数据</div>
          </div>
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
import { formatSize } from '@/utils/format';

interface FileTypeResponse {
  categories: { name: string; fileCount: number; totalSize: string; percentage: number }[];
}

const CATEGORY_COLORS: Record<string, string> = {
  'image': '#4FC3F7',
  'video': '#EF5350',
  'audio': '#AB47BC',
  'document': '#66BB6A',
  'archive': '#FFA726',
  'other': '#90A4AE',
};

function getColor(name: string): string {
  return CATEGORY_COLORS[name] || '#90A4AE';
}

function getLabel(name: string): string {
  const map: Record<string, string> = {
    image: '图片',
    video: '视频',
    audio: '音频',
    document: '文档',
    archive: '压缩包',
    other: '其他',
  };
  return map[name] || name;
}

const timeRange = ref('24h');
const loading = ref(false);
const data = ref<FileTypeResponse | null>(null);

const chartRef = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

const typeColumns = [
  { colKey: 'name', title: '类型', width: 100 },
  { colKey: 'fileCount', title: '文件数量', width: 100 },
  { colKey: 'totalSize', title: '总大小', width: 120 },
  { colKey: 'percentage', title: '占比', width: 80 },
];

function renderChart() {
  if (!chartRef.value) return;
  chart?.dispose();
  chart = echarts.init(chartRef.value, 'dark');

  const categories = data.value?.categories || [];
  const pieData = categories.length > 0
    ? categories.map((c) => ({
        name: getLabel(c.name),
        value: c.fileCount,
        itemStyle: { color: getColor(c.name) },
      }))
    : [{ name: '无数据', value: 1, itemStyle: { color: '#444' } }];

  chart.setOption({
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(30,30,30,0.9)',
      borderColor: '#444',
      textStyle: { color: '#eee' },
      formatter: (params: unknown) => {
        const p = params as { name: string; value: number; percent: string };
        return `${p.name}: ${p.value} 个文件 (${p.percent}%)`;
      },
    },
    legend: {
      orient: 'vertical',
      right: 10,
      top: 'center',
      textStyle: { color: '#aaa', fontSize: 12 },
    },
    series: [
      {
        type: 'pie',
        radius: ['40%', '70%'],
        center: ['40%', '50%'],
        data: pieData,
        label: { show: false },
        emphasis: { label: { show: true, fontSize: 16, fontWeight: 'bold' } },
      },
    ],
  });
}

async function fetchData() {
  loading.value = true;
  try {
    const { data: res } = await api.get('/admin/file-type-stats', {
      params: { timeRange: timeRange.value },
    });
    data.value = (res.data || res) as FileTypeResponse;
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
.file-type-page {
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

/* Charts row */
.charts-row {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
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
  .charts-row {
    flex-direction: column;
  }
}
</style>
