<template>
  <div class="security-page">
    <div class="page-header">
      <h1>安全监控</h1>
      <p>告警处置、封禁管理与异常流量监控</p>
    </div>

    <t-tabs v-model="activeTab">
      <t-tab-panel value="alerts" label="告警管理" />
      <t-tab-panel value="bans" label="封禁统计" />
      <t-tab-panel value="abnormal" label="异常 IP 监控" />
      <t-tab-panel v-if="isSuperAdmin" value="config" label="安全配置" />
    </t-tabs>

    <!-- Tab: 封禁统计 -->
    <div v-if="activeTab === 'bans'" class="tab-content">
      <div class="metrics-grid">
        <div class="metric-card">
          <div class="metric-label">总封禁数</div>
          <div class="metric-value">{{ banStats.totalBanned ?? '-' }}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">活跃封禁</div>
          <div class="metric-value">{{ banStats.activeBans ?? '-' }}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">永久封禁</div>
          <div class="metric-value">{{ banStats.permanentBans ?? '-' }}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">历史封禁</div>
          <div class="metric-value">{{ banStats.historicalBans ?? '-' }}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">解封率</div>
          <div class="metric-value">{{ banStats.unbanRatio != null ? banStats.unbanRatio + '%' : '-' }}</div>
        </div>
      </div>

      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
          <h3 class="card-title" style="margin: 0">近期封禁记录</h3>
          <t-button theme="danger" size="small" @click="openBanDialog()">
            手动封禁 IP
          </t-button>
        </div>
        <t-loading :loading="bansLoading" size="small">
          <div v-if="!isMobile && recentBans.length > 0">
            <t-table
              :data="recentBans"
              :columns="banColumns"
              row-key="ip"
              table-layout="fixed"
              :pagination="false"
              size="small"
            >
              <template #createdAt="{ row }">
                {{ formatDate(row.createdAt) }}
              </template>
              <template #isPermanent="{ row }">
                <t-tag :theme="row.isPermanent ? 'danger' : 'success'" variant="light" size="small">
                  {{ row.isPermanent ? '是' : '否' }}
                </t-tag>
              </template>
              <template #action="{ row }">
                <t-popconfirm content="确定解除该 IP 的封禁？" @confirm="handleUnban(row.ip)">
                  <t-button variant="outline" size="small" theme="default" :loading="unbanningIp === row.ip">
                    解封
                  </t-button>
                </t-popconfirm>
              </template>
            </t-table>
          </div>
          <div v-if="isMobile && recentBans.length > 0" class="mobile-card-list">
            <div v-for="ban in recentBans" :key="ban.ip" class="mobile-card">
              <div class="mobile-card-row">
                <strong>{{ ban.ip }}</strong>
                <t-tag :theme="ban.isPermanent ? 'danger' : 'success'" variant="light" size="small">
                  {{ ban.isPermanent ? '永久' : '临时' }}
                </t-tag>
              </div>
              <div v-if="ban.reason" class="mobile-card-body">{{ ban.reason }}</div>
              <div class="mobile-card-meta">
                <span>{{ formatDate(ban.createdAt) }}</span>
                <t-popconfirm content="确定解除该 IP 的封禁？" @confirm="handleUnban(ban.ip)">
                  <t-button variant="outline" size="small" theme="default" :loading="unbanningIp === ban.ip">
                    解封
                  </t-button>
                </t-popconfirm>
              </div>
            </div>
          </div>
          <div v-if="!bansLoading && recentBans.length === 0" class="empty-hint">暂无活跃封禁</div>
        </t-loading>
      </div>

      <!-- 封禁历史 -->
      <div class="card" style="margin-top: 16px">
        <h3 class="card-title" style="margin: 0 0 16px">封禁历史（已解封/已过期）</h3>
        <t-loading :loading="bansLoading" size="small">
          <div v-if="!isMobile && banHistory.length > 0">
            <t-table
              :data="banHistory"
              :columns="banHistoryColumns"
              row-key="ip"
              table-layout="fixed"
              :pagination="false"
              size="small"
            >
              <template #createdAt="{ row }">
                {{ formatDate(row.createdAt) }}
              </template>
              <template #unbannedAt="{ row }">
                {{ formatDate(row.unbannedAt) }}
              </template>
              <template #isPermanent="{ row }">
                <t-tag :theme="row.isPermanent ? 'danger' : 'success'" variant="light" size="small">
                  {{ row.isPermanent ? '永久' : '临时' }}
                </t-tag>
              </template>
            </t-table>
          </div>
          <div v-if="isMobile && banHistory.length > 0" class="mobile-card-list">
            <div v-for="ban in banHistory" :key="ban.ip" class="mobile-card">
              <div class="mobile-card-row">
                <strong>{{ ban.ip }}</strong>
                <t-tag :theme="ban.isPermanent ? 'danger' : 'success'" variant="light" size="small">
                  {{ ban.isPermanent ? '永久' : '临时' }}
                </t-tag>
              </div>
              <div v-if="ban.reason" class="mobile-card-body">{{ ban.reason }}</div>
              <div class="mobile-card-meta">
                <span>{{ formatDate(ban.createdAt) }}</span>
                <span>解封: {{ formatDate(ban.unbannedAt) }}</span>
              </div>
            </div>
          </div>
          <div v-if="!bansLoading && banHistory.length === 0" class="empty-hint">暂无封禁历史</div>
        </t-loading>
      </div>
    </div>

    <!-- Tab 3: 异常 IP 监控 -->
    <div v-if="activeTab === 'abnormal'" class="tab-content">
      <div class="toolbar">
        <t-select
          v-model="abnormalSort"
          placeholder="排序方式"
          style="width: 160px"
          @change="fetchAbnormalIps"
        >
          <t-option value="requestCount" label="按请求数" />
          <t-option value="errorRate" label="按错误率" />
          <t-option value="bandwidth" label="按带宽" />
        </t-select>
      </div>

      <div class="card">
        <t-loading :loading="abnormalLoading" size="small">
          <div v-if="!isMobile && abnormalIps.length > 0">
            <t-table
              :data="abnormalIps"
              :columns="abnormalColumns"
              row-key="ip"
              table-layout="fixed"
              :pagination="false"
              size="small"
            >
              <template #requestCount="{ row }">
                {{ row.requestCount }}
              </template>
              <template #errorRate="{ row }">
                <t-tag
                  :theme="errorRateTheme(row.errorRate)"
                  variant="light"
                  size="small"
                >
                  {{ row.errorRate.toFixed(1) }}%
                </t-tag>
              </template>
              <template #bandwidth="{ row }">
                {{ formatSize(row.bandwidth) }}
              </template>
              <template #riskLevel="{ row }">
                <t-tag :theme="riskTheme(row.riskLevel)" variant="light" size="small">
                  {{ riskLabel(row.riskLevel) }}
                </t-tag>
              </template>
              <template #action="{ row }">
                <t-button variant="outline" size="small" theme="danger" @click="openBanDialog(row.ip)">
                  封禁 IP
                </t-button>
              </template>
            </t-table>
          </div>
          <div v-if="isMobile && abnormalIps.length > 0" class="mobile-card-list">
            <div v-for="ip in abnormalIps" :key="ip.ip" class="mobile-card">
              <div class="mobile-card-row">
                <strong>{{ ip.ip }}</strong>
                <t-tag :theme="riskTheme(ip.riskLevel)" variant="light" size="small">
                  {{ riskLabel(ip.riskLevel) }}
                </t-tag>
              </div>
              <div class="mobile-card-body">
                <span>请求: {{ ip.requestCount }}</span>
                <span>错误率: {{ ip.errorRate.toFixed(1) }}%</span>
                <span>带宽: {{ formatSize(ip.bandwidth) }}</span>
              </div>
              <div class="mobile-card-meta">
                <t-button variant="outline" size="small" theme="danger" @click="openBanDialog(ip.ip)">
                  封禁 IP
                </t-button>
              </div>
            </div>
          </div>
          <div v-if="!abnormalLoading && abnormalIps.length === 0" class="empty-hint">暂无异常 IP</div>
        </t-loading>
      </div>
    </div>

    <!-- Tab 4: 告警管理 -->
    <div v-if="activeTab === 'alerts'" class="tab-content">
      <AlertManagement />
    </div>

    <!-- Tab 5: 安全配置（仅超级管理员） -->
    <div v-if="activeTab === 'config'" class="tab-content">
      <div class="card" style="margin-bottom: 16px">
        <h3 class="card-title" style="margin: 0 0 4px">安全规则配置</h3>
        <p style="margin: 0; color: var(--text-secondary); font-size: 13px">
          调整攻击检测阈值和自动封禁时长。修改后立即生效，无需重启服务。
        </p>
      </div>

      <t-loading :loading="configLoading" size="small">
        <div v-for="category in configCategories" :key="category" style="margin-bottom: 24px">
          <h4 style="margin: 0 0 12px; font-size: 15px; font-weight: 500; color: var(--text-primary)">
            {{ category }}
          </h4>
          <div class="security-config-grid" :class="{ 'mobile-single-col': isMobile }">
            <div
              v-for="item in configItemsByCategory(category)"
              :key="item.key"
              class="security-config-item"
            >
              <div class="config-item-header">
                <span class="config-item-label">{{ item.label }}</span>
                <span v-if="item.unit" class="config-item-unit">{{ item.unit }}</span>
              </div>
              <t-input-number
                v-model="configForm[item.key]"
                :min="item.min"
                :max="item.max"
                :step="item.step || 1"
                :decimal-places="item.step && item.step < 1 ? 2 : 0"
                style="width: 100%"
                size="small"
              />
              <div class="config-item-hint" :title="item.description">
                {{ item.description }}
              </div>
            </div>
          </div>
        </div>

        <div v-if="configLoadError" class="config-load-error" role="alert">
          {{ configLoadError }}
        </div>
        <div v-if="configItems.length > 0" style="margin-top: 24px; display: flex; gap: 12px">
          <t-button theme="primary" :loading="configSaving" :disabled="!configLoaded" @click="saveSecurityConfig">
            保存配置
          </t-button>
          <t-button theme="default" variant="outline" :loading="configLoading" :disabled="!configLoaded" @click="resetSecurityConfig">
            重置为默认值
          </t-button>
        </div>
        <div v-else class="placeholder-block">
          <div class="placeholder-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
          </div>
          <h3>暂无安全配置项</h3>
          <p>请确保后端安全配置接口正常</p>
        </div>
      </t-loading>
    </div>
  </div>

  <!-- 封禁 IP 对话框 -->
  <t-dialog
    v-model:visible="banDialogVisible"
    header="封禁 IP"
    :confirm-btn="{ content: '确认封禁', theme: 'danger', loading: banDialogSaving }"
    :on-confirm="handleBanSubmit"
    width="460px"
  >
    <t-form label-width="80px">
      <t-form-item label="IP 地址">
        <t-input v-model="banForm.ip" placeholder="输入要封禁的 IP 地址" autocomplete="off" name="ban-ip" />
      </t-form-item>
      <t-form-item label="封禁原因">
        <t-input v-model="banForm.reason" placeholder="封禁原因（选填）" autocomplete="off" name="ban-reason" />
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
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch, defineAsyncComponent } from 'vue';
import axios from 'axios';
import { DialogPlugin } from 'tdesign-vue-next';
import MessagePlugin from '@/utils/message';
import { api, useAuthStore } from '@/stores/auth';
import { storeToRefs } from 'pinia';
import { formatDate, formatSize } from '@/utils/format';
import { isValidIP } from '@/utils/ip';
import { useMobile } from '../../composables/useMobile';

// 懒加载：AlertManagement 仅在切换到告警管理 tab 时才加载
const AlertManagement = defineAsyncComponent(() => import('./AlertManagement.vue'));

const authStore = useAuthStore();
const { user } = storeToRefs(authStore);
const isSuperAdmin = computed(() => user.value?.role === 'super_admin');
const isMobile = useMobile();

// Types
interface BannedIp {
  ip: string;
  reason: string;
  createdAt: string;
  isPermanent: boolean;
}

interface BanStats {
  totalBanned: number;
  activeBans: number;
  permanentBans: number;
  historicalBans: number;
  unbanRatio: number;
}

interface BanHistoryEntry {
  ip: string;
  reason: string | null;
  createdAt: string;
  isPermanent: boolean;
  unbannedAt: string;
}

interface AbnormalIp {
  ip: string;
  requestCount: number;
  errorRate: number;
  bandwidth: number;
  uniquePaths: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

// State
// v1.2.6：告警管理为安全页默认入口；支持 ?tab=bans|abnormal|config 深链定位
const validTabs = ['alerts', 'bans', 'abnormal', 'config'] as const;
function resolveInitialTab(): string {
  const requested = new URLSearchParams(window.location.search).get('tab');
  if (requested && (validTabs as readonly string[]).includes(requested)) {
    if (requested === 'config' && !isSuperAdmin.value) return 'alerts';
    return requested;
  }
  return 'alerts';
}
const activeTab = ref(resolveInitialTab());

// 告警横幅深链消费：/admin/security?tab=alerts 打开后清除 query，避免刷新时重复定位
if (window.history.length > 0 && window.location.search.includes('tab=')) {
  const url = new URL(window.location.href);
  url.searchParams.delete('tab');
  window.history.replaceState({}, '', url.pathname + url.search);
}

// Ban stats
const banStats = reactive<BanStats>({
  totalBanned: 0,
  activeBans: 0,
  permanentBans: 0,
  historicalBans: 0,
  unbanRatio: 0,
});
const recentBans = ref<BannedIp[]>([]);
const banHistory = ref<BanHistoryEntry[]>([]);
const bansLoading = ref(false);
const unbanningIp = ref<string | null>(null);

// Abnormal IPs
const abnormalIps = ref<AbnormalIp[]>([]);
const abnormalLoading = ref(false);
const abnormalSort = ref('requestCount');

// Table columns
const banColumns = [
  { colKey: 'ip', title: 'IP 地址', width: 160 },
  { colKey: 'reason', title: '封禁原因', ellipsis: true },
  { colKey: 'createdAt', title: '封禁时间', width: 180 },
  { colKey: 'isPermanent', title: '类型', width: 80 },
  { colKey: 'action', title: '操作', width: 80 },
];

const banHistoryColumns = [
  { colKey: 'ip', title: 'IP 地址', width: 160 },
  { colKey: 'reason', title: '封禁原因', ellipsis: true },
  { colKey: 'createdAt', title: '封禁时间', width: 180 },
  { colKey: 'unbannedAt', title: '解封时间', width: 180 },
  { colKey: 'isPermanent', title: '类型', width: 80 },
];

const abnormalColumns = [
  { colKey: 'ip', title: 'IP 地址', width: 150 },
  { colKey: 'requestCount', title: '请求数', width: 90 },
  { colKey: 'errorRate', title: '错误率', width: 100 },
  { colKey: 'bandwidth', title: '带宽', width: 100 },
  { colKey: 'uniquePaths', title: '路径数', width: 80 },
  { colKey: 'riskLevel', title: '风险等级', width: 90 },
  { colKey: 'action', title: '操作', width: 90 },
];

// isValidIP 由公共 util 提供（G15-28）：严格 IPv4/IPv6 校验，与 Config.vue 保持一致

// Error rate tag theme
function errorRateTheme(rate: number): string {
  if (rate > 30) return 'danger';
  if (rate >= 10) return 'warning';
  return 'success';
}

// Risk helpers
function riskTheme(level: string): string {
  const map: Record<string, string> = {
    low: 'success',
    medium: 'warning',
    high: 'danger',
    critical: 'danger',
  };
  return map[level] || 'default';
}

function riskLabel(level: string): string {
  const map: Record<string, string> = {
    low: '低',
    medium: '中',
    high: '高',
    critical: '严重',
  };
  return map[level] || level;
}

// Fetch ban stats
async function fetchBanStats() {
  bansLoading.value = true;
  try {
    const { data } = await api.get('/admin/ban-stats');
    const d = data.data || data;
    Object.assign(banStats, d);
    recentBans.value = d.recentBans || [];
    banHistory.value = d.banHistory || [];
  } catch {
    MessagePlugin.error('加载封禁统计失败');
  } finally {
    bansLoading.value = false;
  }
}

// Unban IP
async function handleUnban(ip: string) {
  unbanningIp.value = ip;
  try {
    await api.post('/admin/banned-ips/unban', { ip });
    MessagePlugin.success(`IP ${ip} 已解封`);
    fetchBanStats();
  } catch {
    MessagePlugin.error(`解封 IP ${ip} 失败`);
  } finally {
    unbanningIp.value = null;
  }
}

// Fetch abnormal IPs
async function fetchAbnormalIps() {
  abnormalLoading.value = true;
  try {
    const { data } = await api.get('/admin/access-logs/abnormal-ips', {
      params: {
        timeRange: '24h',
        limit: 50,
        minRequests: 50,
        sortBy: abnormalSort.value,
      },
    });
    abnormalIps.value = (data.data || data) as AbnormalIp[];
  } catch {
    MessagePlugin.error('加载异常 IP 失败');
  } finally {
    abnormalLoading.value = false;
  }
}

// Ban dialog
const banDialogVisible = ref(false);
const banDialogSaving = ref(false);
const banForm = reactive({
  ip: '',
  reason: '',
  isPermanent: false,
  durationHours: 6,
});

function openBanDialog(ip?: string) {
  banForm.ip = ip || '';
  banForm.reason = ip ? 'abnormal_traffic' : '';
  banForm.isPermanent = false;
  banForm.durationHours = 6;
  banDialogVisible.value = true;
}

async function handleBanSubmit() {
  if (!banForm.ip.trim()) {
    MessagePlugin.warning('请输入 IP 地址');
    return;
  }
  if (!isValidIP(banForm.ip.trim())) {
    MessagePlugin.warning('IP 地址格式无效，请输入合法的 IPv4 或 IPv6 地址');
    return;
  }
  banDialogSaving.value = true;
  try {
    const payload: Record<string, any> = {
      ip: banForm.ip.trim(),
      permanent: banForm.isPermanent,
    };
    if (banForm.reason.trim()) {
      payload.reason = banForm.reason.trim();
    }
    if (!banForm.isPermanent) {
      payload.expiresAt = new Date(Date.now() + banForm.durationHours * 60 * 60 * 1000).toISOString();
    }
    await api.post('/admin/banned-ips', payload);
    const type = banForm.isPermanent ? '永久封禁' : `已封禁 ${banForm.durationHours} 小时`;
    MessagePlugin.success(`IP ${banForm.ip.trim()} ${type}`);
    banDialogVisible.value = false;
    // 从异常列表移除
    abnormalIps.value = abnormalIps.value.filter((item) => item.ip !== banForm.ip.trim());
    fetchBanStats();
  } catch {
    MessagePlugin.error(`封禁 IP ${banForm.ip.trim()} 失败`);
  } finally {
    banDialogSaving.value = false;
  }
}

// ==================== 安全规则配置 ====================

interface SecurityConfigItem {
  key: string;
  label: string;
  description: string;
  type: 'number';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  category: string;
  currentValue: string;
  defaultValue: string;
}

const configItems = ref<SecurityConfigItem[]>([]);
const configForm = ref<Record<string, number>>({});
const configLoading = ref(false);
const configSaving = ref(false);
const configLoaded = ref(false);
const configLoadError = ref('');

const configCategories = computed(() => {
  const cats = new Set(configItems.value.map((item) => item.category));
  return Array.from(cats);
});

function configItemsByCategory(cat: string) {
  return configItems.value.filter((item) => item.category === cat);
}

function getApiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const message = error.response?.data && typeof error.response.data === 'object'
      ? (error.response.data as { message?: unknown }).message
      : undefined;
    if (typeof message === 'string' && message.trim()) return message;
    if (error.response?.status === 401) return '登录已失效，请重新登录后再试';
    if (error.response?.status === 403) return '当前账号没有修改安全配置的权限';
    if (error.response?.status && error.response.status >= 500) return '服务端写入安全配置失败，请稍后重试';
    if (!error.response) return '网络异常，无法连接到安全配置服务';
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

function validateSecurityConfig(item: SecurityConfigItem, value: unknown): string | null {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return `${item.label} 必须为有效数值`;
  if (item.min !== undefined && numberValue < item.min) return `${item.label} 不能小于 ${item.min}`;
  if (item.max !== undefined && numberValue > item.max) return `${item.label} 不能大于 ${item.max}`;
  if (item.step !== undefined) {
    const precision = String(item.step).split('.')[1]?.length || 0;
    const scale = 10 ** precision;
    const base = item.min ?? 0;
    if (Math.abs(Math.round((numberValue - base) * scale) % Math.round(item.step * scale)) !== 0) {
      return `${item.label} 必须按步长 ${item.step} 设置`;
    }
  }
  return null;
}

async function fetchSecurityConfig(options: { silent?: boolean } = {}): Promise<boolean> {
  configLoading.value = true;
  configLoadError.value = '';
  try {
    const { data } = await api.get('/admin/security-config');
    const items: SecurityConfigItem[] = data?.data || data || [];
    if (!Array.isArray(items) || items.length === 0) throw new Error('未获取到安全配置项');
    const form: Record<string, number> = {};
    for (const item of items) {
      const cur = Number(item.currentValue);
      const fallback = Number(item.defaultValue);
      if (!Number.isFinite(cur) && !Number.isFinite(fallback)) throw new Error(`${item.label} 的当前值无效`);
      form[item.key] = Number.isFinite(cur) ? cur : fallback;
    }
    configItems.value = items;
    configForm.value = form;
    configLoaded.value = true;
    return true;
  } catch (error) {
    configLoaded.value = false;
    configLoadError.value = getApiErrorMessage(error, '加载安全配置失败，暂不能保存');
    if (!options.silent) MessagePlugin.error(configLoadError.value);
    return false;
  } finally {
    configLoading.value = false;
  }
}

/**
 * 保存安全配置：安全阈值修改后立即生效，若将阈值放大到接近/超过默认值 N 倍，
 * 等效于关闭对应防护，必须先二次确认；保存成功后展示变更摘要（G15-10）。
 */
async function saveSecurityConfig() {
  if (!configLoaded.value) {
    MessagePlugin.warning('安全配置尚未成功加载，不能保存');
    return;
  }

  const RISK_MULTIPLE = 10;
  const changed: { key: string; label: string; before: number; after: number }[] = [];
  const risky: { key: string; label: string; after: number }[] = [];
  for (const item of configItems.value) {
    const before = Number(item.currentValue);
    const after = configForm.value[item.key];
    const validationMessage = validateSecurityConfig(item, after);
    if (validationMessage) {
      MessagePlugin.error(validationMessage);
      return;
    }
    if (before === after) continue;
    changed.push({ key: item.key, label: item.label, before, after });
    const defaultValue = Number(item.defaultValue);
    if (defaultValue > 0 && after > 0 && after >= defaultValue * RISK_MULTIPLE) {
      risky.push({ key: item.key, label: item.label, after });
    }
  }

  if (changed.length === 0) {
    MessagePlugin.info('没有需要保存的配置变更');
    return;
  }

  const doSave = async () => {
    configSaving.value = true;
    try {
      const configs = changed.map(({ key, after }) => ({ key, value: String(after) }));
      await api.put('/admin/security-config', { configs });
      const reloaded = await fetchSecurityConfig({ silent: true });
      if (!reloaded) {
        MessagePlugin.warning('安全配置已提交，但回读确认失败，请刷新页面后核对');
        return;
      }
      const summary = changed.map((change) => `· ${change.label}: ${change.before} → ${change.after}`).join('\n');
      MessagePlugin.success(`安全配置已保存并确认：\n${summary}`);
    } catch (error) {
      MessagePlugin.error(getApiErrorMessage(error, '保存安全配置失败'));
    } finally {
      configSaving.value = false;
    }
  };

  if (risky.length > 0) {
    const confirmDialog = DialogPlugin.confirm({
      header: '检测到高风险配置变更',
      body: '以下项被调整为默认值的 10 倍以上，可能等效于关闭或大幅削弱对应安全防护，请谨慎确认：\n\n'
        + risky.map((r) => `· ${r.label}（${r.after}）`).join('\n'),
      theme: 'warning',
      confirmBtn: '仍要保存',
      cancelBtn: '取消',
      onConfirm: () => {
        confirmDialog.destroy();
        void doSave();
      },
      onClose: () => confirmDialog.destroy(),
    });
    return;
  }

  await doSave();
}

async function resetSecurityConfig() {
  if (!configLoaded.value) {
    MessagePlugin.warning('安全配置尚未成功加载，不能重置');
    return;
  }
  configLoading.value = true;
  try {
    // 恢复为默认值
    const form: Record<string, number> = {};
    for (const item of configItems.value) {
      form[item.key] = Number(item.defaultValue) || 0;
    }
    configForm.value = form;
    MessagePlugin.info('已重置为默认值（点击保存生效）');
  } finally {
    configLoading.value = false;
  }
}

// 角色可能在挂载后异步更新为超级管理员，届时补加载安全配置，避免配置 tab 显示但数据缺失
watch(isSuperAdmin, (val) => {
  if (val && configItems.value.length === 0 && !configLoading.value) {
    fetchSecurityConfig();
  }
});

onMounted(() => {
  // 并发发起所有独立请求，失败的不影响其他数据区域渲染
  // v1.2.6：攻击检测展示页已移除；后端检测任务与告警管理页继续承担该职责
  fetchBanStats();
  fetchAbnormalIps();
  if (isSuperAdmin.value) {
    fetchSecurityConfig();
  }
});
</script>

<style scoped>
.security-page {
  padding: 0;
}

.tab-content {
  padding-top: 20px;
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

/* Toolbar */
.toolbar {
  margin-bottom: 16px;
}

/* Placeholder */
.placeholder-block {
  text-align: center;
  padding: 60px 20px;
}

.placeholder-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.placeholder-block h3 {
  font-size: 18px;
  font-weight: 500;
  margin: 0 0 8px;
  color: var(--text-primary);
}

.placeholder-block p {
  color: var(--text-secondary);
  font-size: 14px;
  margin: 0;
}

/* Empty hint */
.empty-hint {
  text-align: center;
  padding: 24px 0;
  color: var(--text-secondary);
  font-size: 13px;
}

@media (max-width: 768px) {
  .metrics-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
  }

  .metric-value {
    font-size: 22px;
  }
}

@media (max-width: 480px) {
  .metrics-grid {
    grid-template-columns: 1fr;
  }
}

/* Security config grid */
.security-config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}

.security-config-item {
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 16px;
}

.config-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.config-item-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.config-item-unit {
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--color-bg-elevated);
  padding: 2px 8px;
  border-radius: 4px;
}

.config-load-error {
  margin-top: 16px;
  padding: 12px 14px;
  color: var(--color-danger);
  background: color-mix(in srgb, var(--color-danger) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-danger) 35%, transparent);
  border-radius: var(--radius-sm);
  font-size: 13px;
}

.config-item-hint {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 6px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 768px) {
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
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
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
