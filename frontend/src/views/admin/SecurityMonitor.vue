<template>
  <div class="security-page">
    <div class="page-header">
      <h1>安全监控</h1>
      <p>攻击检测、封禁管理与异常流量监控</p>
    </div>

    <t-tabs v-model="activeTab">
      <t-tab-panel value="detection" label="攻击检测" />
      <t-tab-panel value="bans" label="封禁统计" />
      <t-tab-panel value="abnormal" label="异常 IP 监控" />
      <t-tab-panel value="alerts" label="告警管理" />
      <t-tab-panel v-if="isSuperAdmin" value="config" label="安全配置" />
    </t-tabs>

    <!-- Tab 1: 攻击检测 -->
    <div v-if="activeTab === 'detection'" class="tab-content">
      <!-- 统计卡片 -->
      <div class="metrics-grid" style="margin-bottom: 16px">
        <div class="metric-card" style="border-left: 3px solid #EF5350">
          <div class="metric-label">今日攻击事件</div>
          <div class="metric-value" style="color: #EF5350">{{ attackAlerts.length }}</div>
        </div>
        <div class="metric-card" style="border-left: 3px solid #FF9800">
          <div class="metric-label">高频扫描</div>
          <div class="metric-value" style="color: #FF9800">{{ attackTypeCount('high_frequency_scan') }}</div>
        </div>
        <div class="metric-card" style="border-left: 3px solid #F44336">
          <div class="metric-label">登录爆破</div>
          <div class="metric-value" style="color: #F44336">{{ attackTypeCount('brute_force') }}</div>
        </div>
        <div class="metric-card" style="border-left: 3px solid #FFA726">
          <div class="metric-label">爬虫/异常下载</div>
          <div class="metric-value" style="color: #FFA726">{{ attackTypeCount('crawler') + attackTypeCount('abnormal_download') }}</div>
        </div>
      </div>

      <!-- 攻击告警表格 -->
      <div class="card">
        <h3 style="margin: 0 0 16px;">攻击行为告警</h3>
        <t-loading :loading="attackLoading" size="small">
          <div v-if="!isMobile && attackAlerts.length > 0">
            <t-table
              :data="attackAlerts"
              :columns="attackColumns"
              row-key="id"
              hover
              max-height="500"
            >
              <template #ruleId="{ row }">
                <t-tag variant="light">{{ attackTypeLabel(row.ruleId) }}</t-tag>
              </template>
              <template #level="{ row }">
                <t-tag :theme="row.level === 'critical' ? 'danger' : 'warning'" variant="light-outline">
                  {{ row.level === 'critical' ? '严重' : '警告' }}
                </t-tag>
              </template>
              <template #message="{ row }">
                <span style="font-size:13px">{{ row.message }}</span>
              </template>
              <template #createdAt="{ row }">
                {{ new Date(row.createdAt).toLocaleString('zh-CN') }}
              </template>
              <template #acknowledgedAt="{ row }">
                <span v-if="row.acknowledgedAt" style="color:var(--success-color)">已确认</span>
                <span v-else style="color:var(--warning-color)">待处理</span>
              </template>
            </t-table>
          </div>
          <div v-if="isMobile && attackAlerts.length > 0" class="mobile-card-list">
            <div v-for="alert in attackAlerts" :key="alert.id" class="mobile-card">
              <div class="mobile-card-row">
                <t-tag variant="light" size="small">{{ attackTypeLabel(alert.ruleId) }}</t-tag>
                <t-tag :theme="alert.level === 'critical' ? 'danger' : 'warning'" variant="light-outline" size="small">
                  {{ alert.level === 'critical' ? '严重' : '警告' }}
                </t-tag>
              </div>
              <div class="mobile-card-body">{{ alert.message }}</div>
              <div class="mobile-card-meta">
                <span>{{ new Date(alert.createdAt).toLocaleString('zh-CN') }}</span>
                <span v-if="alert.acknowledgedAt" style="color:var(--success-color)">已确认</span>
                <span v-else style="color:var(--warning-color)">待处理</span>
              </div>
            </div>
          </div>
          <div v-if="!attackAlerts.length" class="placeholder-block">
            <div class="placeholder-icon">✅</div>
            <h3>当前无攻击行为</h3>
            <p>系统每 5 分钟自动检测扫描、爆破、爬虫、异常下载等攻击行为</p>
          </div>
        </t-loading>
      </div>
    </div>

    <!-- Tab 2: 封禁统计 -->
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
          <h3 style="margin: 0">近期封禁记录</h3>
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
        <h3 style="margin: 0 0 16px">封禁历史（已解封/已过期）</h3>
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
        <h3 style="margin: 0 0 4px">安全规则配置</h3>
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

        <div v-if="configItems.length > 0" style="margin-top: 24px; display: flex; gap: 12px">
          <t-button theme="primary" :loading="configSaving" @click="saveSecurityConfig">
            保存配置
          </t-button>
          <t-button theme="default" variant="outline" :loading="configLoading" @click="resetSecurityConfig">
            重置为默认值
          </t-button>
        </div>
        <div v-else class="placeholder-block">
          <div class="placeholder-icon">⚙️</div>
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
import { ref, reactive, onMounted, computed, defineAsyncComponent } from 'vue';
import MessagePlugin from '@/utils/message';
import { api, useAuthStore } from '@/stores/auth';
import { storeToRefs } from 'pinia';
import { formatDate, formatSize } from '@/utils/format';
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

interface AttackAlert {
  id: string;
  ruleId: string;
  level: string;
  title: string;
  message: string;
  context: any;
  acknowledgedAt: string | null;
  createdAt: string;
}

// State
const activeTab = ref('detection');

// Attack alerts
const attackAlerts = ref<AttackAlert[]>([]);
const attackLoading = ref(false);

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

const attackColumns = [
  { colKey: 'ruleId', title: '攻击类型', width: 120, cell: 'ruleId' },
  { colKey: 'level', title: '级别', width: 80, cell: 'level' },
  { colKey: 'message', title: '详情', ellipsis: true, cell: 'message' },
  { colKey: 'createdAt', title: '检测时间', width: 170, cell: 'createdAt' },
  { colKey: 'acknowledgedAt', title: '状态', width: 80, cell: 'acknowledgedAt' },
];

const attackTypeLabels: Record<string, string> = {
  ATTACK_HIGH_FREQUENCY_SCAN: '高频扫描',
  ATTACK_BRUTE_FORCE: '登录爆破',
  ATTACK_CRAWLER: '爬虫行为',
  ATTACK_ABNORMAL_DOWNLOAD: '异常下载',
};

function attackTypeLabel(ruleId: string): string {
  return attackTypeLabels[ruleId] || ruleId.replace('ATTACK_', '').replace(/_/g, ' ');
}

function isValidIP(ip: string): boolean {
  const ipv4Re = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const m = ip.match(ipv4Re);
  if (m) {
    return m.slice(1).every((o) => {
      const n = parseInt(o, 10);
      return n >= 0 && n <= 255 && String(n) === o;
    });
  }
  const ipv6Re = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  return ipv6Re.test(ip);
}

function attackTypeCount(type: string): number {
  return attackAlerts.value.filter(a => a.ruleId === `ATTACK_${type.toUpperCase()}`).length;
}

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

// Fetch attack alerts
async function fetchAttackAlerts() {
  attackLoading.value = true;
  try {
    const { data } = await api.get('/admin/alerts', {
      params: { limit: 50 },
    });
    const items = (data?.data?.items || data?.items || data) as AttackAlert[];
    attackAlerts.value = (Array.isArray(items) ? items : []).filter(
      a => a.ruleId?.startsWith('ATTACK_') || a.ruleId?.startsWith('SEC_'),
    );
  } catch {
    // 静默失败，攻击检测后台自动运行
  } finally {
    attackLoading.value = false;
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

const configCategories = computed(() => {
  const cats = new Set(configItems.value.map((item) => item.category));
  return Array.from(cats);
});

function configItemsByCategory(cat: string) {
  return configItems.value.filter((item) => item.category === cat);
}

async function fetchSecurityConfig() {
  configLoading.value = true;
  try {
    const { data } = await api.get('/admin/security-config');
    const items: SecurityConfigItem[] = data?.data || data || [];
    configItems.value = items;
    // 初始化表单值
    const form: Record<string, number> = {};
    for (const item of items) {
      form[item.key] = Number(item.currentValue) || Number(item.defaultValue) || 0;
    }
    configForm.value = form;
  } catch {
    // 静默失败
  } finally {
    configLoading.value = false;
  }
}

async function saveSecurityConfig() {
  configSaving.value = true;
  try {
    const configs = Object.entries(configForm.value).map(([key, value]) => ({
      key,
      value: String(value),
    }));
    await api.put('/admin/security-config', { configs });
    MessagePlugin.success('安全配置已保存');
    await fetchSecurityConfig();
  } catch {
    MessagePlugin.error('保存安全配置失败');
  } finally {
    configSaving.value = false;
  }
}

async function resetSecurityConfig() {
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

onMounted(() => {
  // 并发发起所有独立请求，失败的不影响其他数据区域渲染
  // Promise.allSettled 确保每个数据块独立到达后各自渲染
  fetchAttackAlerts();
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
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
  padding: 20px;
}

.metric-label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.metric-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
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
  background: var(--bg-primary, #1a1a2e);
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
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
  background: var(--bg-secondary, #2a2a3e);
  padding: 2px 8px;
  border-radius: 4px;
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
