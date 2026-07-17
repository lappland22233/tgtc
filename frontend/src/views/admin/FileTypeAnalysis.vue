<template>
  <div class="file-type-page">
    <div class="page-header">
      <h1>文件类型</h1>
      <p>文件类型分布统计与容量分析</p>
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
        <div class="charts-row" :class="{ 'mobile-single-col': isMobile }">
          <!-- Pie Chart -->
          <div class="card" style="flex: 1; min-width: 340px;">
            <h3>文件类型分布</h3>
            <div ref="chartRef" class="chart-container"></div>
          </div>

          <!-- File Type Table -->
          <div class="card" style="flex: 1; min-width: 340px;">
            <h3>类型详情</h3>
            <div v-if="!isMobile">
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
            <div v-if="isMobile">
              <div v-for="row in data.categories" :key="row.name" class="mobile-card">
                <div class="mobile-card-header">
                  <t-tag
                    :style="{ background: getColor(row.name), borderColor: getColor(row.name) }"
                    variant="light"
                    size="small"
                  >
                    {{ getLabel(row.name) }}
                  </t-tag>
                  <span>{{ row.percentage.toFixed(1) }}%</span>
                </div>
                <div class="mobile-card-meta">
                  <span>{{ row.fileCount }} 个文件</span>
                  <span>{{ formatSize(Number(row.totalSize)) }}</span>
                </div>
              </div>
              <div v-if="!data.categories.length" class="empty-hint">暂无数据</div>
            </div>
          </div>
        </div>
      </template>
      <div v-else-if="!loading" class="empty-hint">暂无数据</div>
    </t-loading>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import * as echarts from '@/utils/echarts';
import { api } from '@/stores/auth';
import { formatSize } from '@/utils/format';
import { useMobile } from '../../composables/useMobile';
import { CHART_COLORS, FILETYPE_COLORS, tooltipBase, legendBase, ensureCyberTheme } from '../../utils/echarts-theme';

interface FileTypeResponse {
  categories: { name: string; fileCount: number; totalSize: string; percentage: number }[];
}

const CATEGORY_COLORS: Record<string, string> = {
  '图片':   FILETYPE_COLORS['图片']   || CHART_COLORS.blue,
  '视频':   FILETYPE_COLORS['视频']   || CHART_COLORS.danger,
  '音频':   FILETYPE_COLORS['音频']   || CHART_COLORS.violet,
  '文档':   FILETYPE_COLORS['文档']   || CHART_COLORS.success,
  '压缩包': FILETYPE_COLORS['压缩包'] || CHART_COLORS.amber,
  '其他':   FILETYPE_COLORS['其他']   || CHART_COLORS.slate,
};

function getColor(name: string): string {
  return CATEGORY_COLORS[name] || CHART_COLORS.slate;
}

function getLabel(name: string): string {
  return name;
}

const timeRange = ref('24h');
const loading = ref(false);
const data = ref<FileTypeResponse | null>(null);

const chartRef = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;
const isMobile = useMobile();

const typeColumns = [
  { colKey: 'name', title: '类型', width: 100 },
  { colKey: 'fileCount', title: '文件数量', width: 100 },
  { colKey: 'totalSize', title: '总大小', width: 120 },
  { colKey: 'percentage', title: '占比', width: 80 },
];

const handleResize = () => {
  chart?.resize();
};

watch(isMobile, () => {
  nextTick(() => setTimeout(handleResize, 100));
});

async function renderChart() {
  if (!chartRef.value) return;
  await ensureCyberTheme();
  chart?.dispose();
  chart = echarts.init(chartRef.value, 'cyber');

  const categories = data.value?.categories || [];
  const pieData = categories.length > 0
    ? categories.map((c) => ({
        name: getLabel(c.name),
        value: c.fileCount,
        itemStyle: { color: getColor(c.name) },
      }))
    : [{ name: '无数据', value: 1, itemStyle: { color: 'rgba(255,255,255,0.08)' } }];

  chart.setOption({
    tooltip: {
      trigger: 'item',
      ...tooltipBase,
      formatter: (params: unknown) => {
        const p = params as { name: string; value: number; percent: string };
        return `${p.name}: ${p.value} 个文件 (${p.percent}%)`;
      },
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
    await renderChart();
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
  nextTick(async () => { await renderChart(); });
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

  .toolbar-row {
    flex-direction: column;
    gap: 8px;
  }

  .mobile-single-col {
    grid-template-columns: 1fr !important;
    flex-direction: column !important;
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
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 14px;
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
