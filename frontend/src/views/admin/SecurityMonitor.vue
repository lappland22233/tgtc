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
          <t-table
            v-if="attackAlerts.length > 0"
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
          <div v-else class="placeholder-block">
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
          <div class="metric-label">解封率</div>
          <div class="metric-value">{{ banStats.unbanRatio != null ? banStats.unbanRatio + '%' : '-' }}</div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin: 0 0 16px">近期封禁记录</h3>
        <t-loading :loading="bansLoading" size="small">
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
          <div v-if="!bansLoading && recentBans.length === 0" class="empty-hint">暂无封禁记录</div>
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
              <t-popconfirm content="确定封禁该 IP？" @confirm="handleBanAbnormalIp(row.ip)">
                <t-button variant="outline" size="small" theme="danger" :loading="banningIp === row.ip">
                  封禁 IP
                </t-button>
              </t-popconfirm>
            </template>
          </t-table>
          <div v-if="!abnormalLoading && abnormalIps.length === 0" class="empty-hint">暂无异常 IP</div>
        </t-loading>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { api } from '@/stores/auth';
import { formatDate, formatSize } from '@/utils/format';

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
  unbanRatio: number;
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
  unbanRatio: 0,
});
const recentBans = ref<BannedIp[]>([]);
const bansLoading = ref(false);
const unbanningIp = ref<string | null>(null);

// Abnormal IPs
const abnormalIps = ref<AbnormalIp[]>([]);
const abnormalLoading = ref(false);
const abnormalSort = ref('requestCount');
const banningIp = ref<string | null>(null);

// Table columns
const banColumns = [
  { colKey: 'ip', title: 'IP 地址', width: 160 },
  { colKey: 'reason', title: '封禁原因', ellipsis: true },
  { colKey: 'createdAt', title: '封禁时间', width: 180 },
  { colKey: 'isPermanent', title: '永久封禁', width: 100 },
  { colKey: 'action', title: '操作', width: 80 },
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
    await api.delete(`/admin/banned-ips/${ip}`, { data: { reason: 'manual_unban' } });
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

// Ban abnormal IP
async function handleBanAbnormalIp(ip: string) {
  banningIp.value = ip;
  try {
    await api.post('/admin/banned-ips', {
      ip,
      reason: 'abnormal_traffic',
      isPermanent: false,
      durationMinutes: 360,
    });
    MessagePlugin.success(`IP ${ip} 已封禁 6 小时`);
    abnormalIps.value = abnormalIps.value.filter((item) => item.ip !== ip);
  } catch {
    MessagePlugin.error(`封禁 IP ${ip} 失败`);
  } finally {
    banningIp.value = null;
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

onMounted(() => {
  fetchAttackAlerts();
  fetchBanStats();
  fetchAbnormalIps();
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
</style>
