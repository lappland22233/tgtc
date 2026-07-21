<template>
  <div class="dashboard-customizer">
    <div class="toolbar-header">
      <h1>仪表盘定制</h1>
      <t-space>
        <t-select v-model="currentDashboardId" placeholder="选择仪表盘" style="width:220px" @change="loadDashboard">
          <t-option v-for="d in dashboards" :key="d.id" :value="d.id" :label="d.name" />
        </t-select>
        <t-select v-model="presetName" placeholder="预设模板" clearable style="width:140px" @change="createPreset">
          <t-option v-for="p in presets" :key="p.name" :value="p.name" :label="p.name" />
        </t-select>
        <t-button theme="primary" @click="showCreateDialog = true">新建</t-button>
        <t-button :variant="editMode ? 'base' : 'outline'" @click="editMode = !editMode">
          {{ editMode ? '完成编辑' : '编辑模式' }}
        </t-button>
        <t-popconfirm v-if="currentDashboardId" content="确定删除此仪表盘？" @confirm="deleteDashboard">
          <t-button theme="danger" variant="outline">删除</t-button>
        </t-popconfirm>
      </t-space>
    </div>

    <!-- View Mode -->
    <div v-if="!editMode && widgets.length > 0" class="dashboard-grid" :class="{ 'mobile-single-col': isMobile }">
      <div
        v-for="w in widgets"
        :key="w.i"
        class="widget-card"
        :style="{ gridColumn: `span ${w.w || 3}` }"
      >
        <WidgetRenderer :widget="w" />
      </div>
    </div>

    <!-- Edit Mode -->
    <div v-if="editMode">
      <t-card v-for="(w, idx) in widgets" :key="w.i" style="margin-bottom:8px" :title="w.config?.title || w.config?.label || `Widget ${idx + 1}`">
        <template #actions>
          <t-button size="small" variant="text" @click="moveWidget(idx, -1)" :disabled="idx === 0">↑</t-button>
          <t-button size="small" variant="text" @click="moveWidget(idx, 1)" :disabled="idx === widgets.length - 1">↓</t-button>
          <t-popconfirm content="删除此组件？" @confirm="removeWidget(idx)">
            <t-button size="small" theme="danger" variant="text">删除</t-button>
          </t-popconfirm>
        </template>
        <t-space direction="vertical" style="width:100%">
          <t-select v-model="w.type" :options="widgetTypeOptions" placeholder="组件类型" style="width:200px" />
          <t-input v-if="w.type === 'metric-card'" v-model="w.config.label" placeholder="标签" style="width:200px" autocomplete="off" name="widget-label" />
          <t-input v-model="w.config.title" placeholder="标题" style="width:200px" autocomplete="off" name="widget-title" />
          <t-input v-model="w.config.endpoint" placeholder="数据端点 (如 /admin/access-logs/stats)" autocomplete="off" name="widget-endpoint" />
          <t-input v-model="w.config.metric" v-if="w.type === 'metric-card'" placeholder="指标字段名" style="width:200px" autocomplete="off" name="widget-metric" />
          <t-select v-model="w.config.format" v-if="w.type === 'metric-card'" :options="formatOptions" placeholder="格式" style="width:150px" />
          <t-input-number v-model="w.w" :min="1" :max="12" label="宽度(列)" style="width:150px" />
        </t-space>
      </t-card>

      <t-button style="margin-bottom:8px" block variant="dashed" @click="addWidget">+ 添加组件</t-button>
      <t-button theme="primary" block @click="saveDashboard" :loading="saving">保存仪表盘</t-button>
    </div>

    <!-- Empty state -->
    <div v-if="!editMode && widgets.length === 0" class="empty-state">
      <p>尚未创建仪表盘或仪表盘为空</p>
      <p>点击"预设模板"快速创建，或点击"新建"创建空白仪表盘</p>
    </div>

    <!-- Create dialog -->
    <t-dialog v-model:visible="showCreateDialog" header="新建仪表盘" @confirm="createDashboard">
      <t-input v-model="newDashboardName" placeholder="仪表盘名称" autocomplete="off" name="dashboard-name" />
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import MessagePlugin from '@/utils/message';
import { useMobile } from '@/composables/useMobile';
import { api } from '@/stores/auth';

interface WidgetInnerConfig {
  label?: string;
  title?: string;
  endpoint?: string;
  metric?: string;
  format?: 'number' | 'size' | 'percent' | 'ms';
}

interface WidgetConfig {
  i: string;
  type: string;
  w: number;
  h: number;
  config: WidgetInnerConfig;
}

interface DashboardItem {
  id: string;
  name: string;
  config: WidgetConfig[];
  isDefault: boolean;
}

const dashboards = ref<DashboardItem[]>([]);
const presets = ref<{ name: string; widgetCount: number }[]>([]);
const currentDashboardId = ref('');
const widgets = ref<WidgetConfig[]>([]);
const editMode = ref(false);
const saving = ref(false);
const showCreateDialog = ref(false);
const newDashboardName = ref('');
const presetName = ref('');

const isMobile = useMobile();

const widgetTypeOptions = [
  { label: '指标卡片', value: 'metric-card' },
  { label: '折线图', value: 'chart-line' },
  { label: '饼图', value: 'chart-pie' },
  { label: '柱状图', value: 'chart-bar' },
  { label: '表格', value: 'table' },
];

const formatOptions = [
  { label: '数字', value: 'number' },
  { label: '大小', value: 'size' },
  { label: '百分比', value: 'percent' },
  { label: '毫秒', value: 'ms' },
];

// 组件数据端点白名单：仅允许只读的管理统计接口，防止把 widget 端点
// 指向任意内部 API（前端 SSRF 入口）。新增合法端点时在此登记。
const ALLOWED_ENDPOINT_PREFIXES = [
  '/admin/access-logs',
  '/admin/telemetry',
  '/admin/stats',
  '/admin/dashboard',
  '/admin/file-type-stats',
  '/admin/bandwidth',
  '/admin/source-analysis',
  '/admin/user-activity',
  '/admin/alerts',
  '/admin/security-monitor',
];

function isValidWidgetEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return false;
  // 必须是站内相对路径，拒绝协议相对（//evil.com）与绝对 URL
  if (!endpoint.startsWith('/') || endpoint.startsWith('//')) return false;
  return ALLOWED_ENDPOINT_PREFIXES.some(
    p => endpoint === p || endpoint.startsWith(p + '/'),
  );
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

async function fetchDashboards() {
  try {
    const res = await api.get('/admin/dashboards');
    const body = res.data;
    dashboards.value = Array.isArray(body?.data) ? body.data : [];
  } catch (err) {
    console.error('加载仪表盘列表失败', err);
  }
}

async function fetchPresets() {
  try {
    const res = await api.get('/admin/dashboards/presets');
    const body = res.data;
    presets.value = Array.isArray(body?.data) ? body.data : [];
  } catch (err) {
    console.error('加载预设模板失败', err);
  }
}

async function loadDashboard() {
  if (!currentDashboardId.value) { widgets.value = []; return; }
  try {
    const res = await api.get(`/admin/dashboards/${currentDashboardId.value}`);
    const dash = res.data?.data || null;
    widgets.value = (dash?.config || []).map((w: any) => ({
      i: w.i || uid(),
      type: w.type || 'metric-card',
      w: w.w || 3,
      h: w.h || 2,
      config: w.config || {},
    }));
  } catch { widgets.value = []; }
}

async function saveDashboard() {
  if (!currentDashboardId.value) { MessagePlugin.warning('请先选择或创建仪表盘'); return; }
  // 保存前校验所有组件端点，防止把非法/任意内部 API 端点持久化（SSRF 防护）
  const invalid = widgets.value.find(w => !isValidWidgetEndpoint(w.config?.endpoint));
  if (invalid) {
    MessagePlugin.warning('组件「' + (invalid.config?.title || invalid.i) + '」的数据端点不在允许范围内，请修改后重试');
    return;
  }
  saving.value = true;
  try {
    await api.put(`/admin/dashboards/${currentDashboardId.value}`, { config: widgets.value });
    MessagePlugin.success('保存成功');
    editMode.value = false;
  } catch { MessagePlugin.error('保存失败'); }
  saving.value = false;
}

async function createDashboard() {
  if (!newDashboardName.value) return;
  try {
    const res = await api.post('/admin/dashboards', { name: newDashboardName.value });
    const dash = res.data?.data || null;
    if (!dash || !dash.id) { MessagePlugin.error('创建失败：无效响应'); return; }
    dashboards.value.push(dash);
    currentDashboardId.value = dash.id;
    widgets.value = [];
    newDashboardName.value = '';
    showCreateDialog.value = false;
    MessagePlugin.success('仪表盘已创建');
  } catch { MessagePlugin.error('创建失败'); }
}

async function createPreset() {
  if (!presetName.value) return;
  try {
    const res = await api.post(`/admin/dashboards/presets/${presetName.value}`);
    const dash = res.data?.data || null;
    if (!dash || !dash.id) { MessagePlugin.error('创建失败：无效响应'); return; }
    if (!dashboards.value.find(d => d.id === dash.id)) {
      dashboards.value.push(dash);
    }
    currentDashboardId.value = dash.id;
    await loadDashboard();
    presetName.value = '';
    MessagePlugin.success(`已创建预设模板: ${dash.name}`);
  } catch { MessagePlugin.error('创建预设失败'); }
}

async function deleteDashboard() {
  if (!currentDashboardId.value) return;
  try {
    await api.delete(`/admin/dashboards/${currentDashboardId.value}`);
    dashboards.value = dashboards.value.filter(d => d.id !== currentDashboardId.value);
    currentDashboardId.value = '';
    widgets.value = [];
    MessagePlugin.success('已删除');
  } catch { MessagePlugin.error('删除失败'); }
}

function addWidget() {
  widgets.value.push({
    i: uid(),
    type: 'metric-card',
    w: 3,
    h: 2,
    config: { label: '新指标', metric: '', endpoint: '/admin/access-logs/stats', format: 'number' },
  });
}

function removeWidget(idx: number) { widgets.value.splice(idx, 1); }

function moveWidget(idx: number, dir: number) {
  const target = idx + dir;
  if (target < 0 || target >= widgets.value.length) return;
  [widgets.value[idx], widgets.value[target]] = [widgets.value[target], widgets.value[idx]];
}

onMounted(() => { fetchDashboards(); fetchPresets(); });
</script>

<style scoped>
.dashboard-customizer { padding: 0; }
.toolbar-header {
  display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;
}
.toolbar-header h1 {
  margin: 0; font-family: var(--font-display); font-size: 22px; font-weight: 700; letter-spacing: -0.02em;
}
.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}
.widget-card {
  background: var(--color-bg-surface);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 16px;
  min-height: 120px;
}
.empty-state {
  text-align: center; padding: 60px 0; color: var(--text-secondary);
}

@media (max-width: 768px) {
  .toolbar-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }

  .toolbar-header > :deep(.t-space) {
    flex-wrap: wrap;
  }

  .dashboard-grid.mobile-single-col {
    grid-template-columns: 1fr;
  }

  .widget-card {
    grid-column: span 1 !important;
    min-height: 100px;
    padding: 12px;
  }
}
</style>
