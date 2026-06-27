<template>
  <div class="dashboard-customizer">
    <div class="page-header">
      <h2>仪表盘定制</h2>
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
    <div v-if="!editMode && widgets.length > 0" class="dashboard-grid">
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
          <t-input v-if="w.type === 'metric-card'" v-model="w.config.label" placeholder="标签" style="width:200px" />
          <t-input v-model="w.config.title" placeholder="标题" style="width:200px" />
          <t-input v-model="w.config.endpoint" placeholder="数据端点 (如 /admin/access-logs/stats)" />
          <t-input v-model="w.config.metric" v-if="w.type === 'metric-card'" placeholder="指标字段名" style="width:200px" />
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
      <t-input v-model="newDashboardName" placeholder="仪表盘名称" />
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { api } from '@/stores/auth';

interface DashboardItem {
  id: string;
  name: string;
  config: any[];
  isDefault: boolean;
}

interface WidgetConfig {
  i: string;
  type: string;
  w: number;
  h: number;
  config: Record<string, any>;
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

function uid() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

async function fetchDashboards() {
  try {
    const res = await api.get('/admin/dashboards');
    dashboards.value = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : []);
  } catch {}
}

async function fetchPresets() {
  try {
    const res = await api.get('/admin/dashboards/presets');
    presets.value = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : []);
  } catch {}
}

async function loadDashboard() {
  if (!currentDashboardId.value) { widgets.value = []; return; }
  try {
    const res = await api.get(`/admin/dashboards/${currentDashboardId.value}`);
    const dash = res.data || res;
    widgets.value = (dash.config || []).map((w: any) => ({
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
    const dash = res.data || res;
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
    const dash = res.data || res;
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
.page-header {
  display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;
}
.page-header h2 { margin: 0; }
.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}
.widget-card {
  background: var(--bg-color-container);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 16px;
  min-height: 120px;
}
.empty-state {
  text-align: center; padding: 60px 0; color: var(--text-secondary);
}
</style>
