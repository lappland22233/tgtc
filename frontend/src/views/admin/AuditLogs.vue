<template>
  <div class="audit-logs-page">
    <div class="page-header">
      <h1>操作审计</h1>
      <p>系统安全事件记录：登录、配置变更、文件操作、权限修改</p>
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <t-radio-group v-model="timeRange" variant="default-filled" @change="onFilterChange">
        <t-radio-button value="1h">1小时</t-radio-button>
        <t-radio-button value="24h">24小时</t-radio-button>
        <t-radio-button value="7d">7天</t-radio-button>
        <t-radio-button value="30d">30天</t-radio-button>
      </t-radio-group>
    </div>

    <!-- 筛选栏 -->
    <div class="table-filters">
      <t-select
        v-model="filterAction"
        placeholder="操作类型"
        clearable
        style="width: 200px;"
        @change="onFilterChange"
      >
        <t-option value="" label="全部操作" />
        <t-option value="login" label="登录" />
        <t-option value="login_failed" label="登录失败" />
        <t-option value="register" label="注册" />
        <t-option value="password_reset" label="密码重置" />
        <t-option value="role_change" label="角色变更" />
        <t-option value="user_create" label="创建用户" />
        <t-option value="user_delete" label="删除用户" />
        <t-option value="user_ban" label="封禁用户" />
        <t-option value="user_unban" label="解封用户" />
        <t-option value="file_upload" label="文件上传" />
        <t-option value="file_delete" label="文件删除" />
        <t-option value="file_delete_request" label="请求删除" />
        <t-option value="file_delete_by_admin" label="管理员删除" />
        <t-option value="file_restore" label="文件恢复" />
        <t-option value="file_share" label="生成分享" />
        <t-option value="file_password_set" label="设置密码" />
        <t-option value="file_access_change" label="访问变更" />
        <t-option value="file_expiry_set" label="有效期设置" />
        <t-option value="config_change" label="配置变更" />
        <t-option value="smtp_config_change" label="SMTP变更" />
        <t-option value="upload_config_change" label="上传配置" />
        <t-option value="auth_config_change" label="认证配置" />
        <t-option value="ip_ban" label="IP封禁" />
        <t-option value="ip_unban" label="IP解封" />
        <t-option value="batch_delete_files" label="批量删除" />
        <t-option value="batch_delete_files_by_admin" label="管理员批量删" />
      </t-select>
      <t-button variant="outline" @click="onRefresh">刷新</t-button>
    </div>

    <div class="card">
      <!-- Desktop table -->
      <t-table
        v-if="!isMobile"
        :data="logs"
        :columns="columns"
        :loading="loading"
        :pagination="pagination"
        row-key="id"
        table-layout="auto"
        @page-change="onPageChange"
      >
        <template #action="{ row }">
          <t-tag :theme="actionTheme(row.action)" variant="light" size="small">
            {{ actionLabel(row.action) }}
          </t-tag>
        </template>
        <template #status="{ row }">
          <t-tag :theme="row.status === 'success' ? 'success' : 'danger'" variant="outline" size="small">
            {{ row.status === 'success' ? '成功' : '失败' }}
          </t-tag>
        </template>
        <template #resourceType="{ row }">
          <span v-if="row.resourceType">{{ resourceTypeLabel(row.resourceType) }}</span>
          <span v-else style="color: var(--text-secondary)">-</span>
        </template>
        <template #metadata="{ row }">
          <span v-if="row.metadata" style="font-size: 12px; color: var(--text-secondary); max-width: 200px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            {{ formatMetadata(row.metadata) }}
          </span>
          <span v-else>-</span>
        </template>
        <template #username="{ row }">
          <span v-if="row.username" style="color: var(--text-primary);">{{ row.username }}</span>
          <span v-else-if="row.userId" :title="row.userId" style="font-size: 11px; color: var(--text-secondary); font-family: monospace;">{{ truncateId(row.userId) }}</span>
          <span v-else style="color: var(--text-secondary)">匿名</span>
        </template>
        <template #createdAt="{ row }">
          {{ formatTime(row.createdAt) }}
        </template>
      </t-table>

      <!-- Mobile cards -->
      <div v-if="isMobile" class="mobile-card-list">
        <t-loading :loading="loading" size="small">
          <div v-if="logs.length === 0 && !loading" style="text-align: center; padding: 24px 0; color: var(--text-secondary);">暂无数据</div>
          <div v-for="item in logs" :key="item.id" class="mobile-audit-card">
            <div class="mobile-audit-header">
              <t-tag :theme="actionTheme(item.action)" variant="light" size="small">{{ actionLabel(item.action) }}</t-tag>
              <t-tag :theme="item.status === 'success' ? 'success' : 'danger'" variant="outline" size="small">{{ item.status === 'success' ? '成功' : '失败' }}</t-tag>
            </div>
            <div class="mobile-audit-body">
              <span>
                <span v-if="item.username" class="mobile-audit-user">{{ item.username }}</span>
                <span v-else-if="item.userId" class="mobile-audit-user-id">{{ truncateId(item.userId) }}</span>
                <span v-else style="color: var(--text-secondary);">匿名</span>
              </span>
              <span class="mobile-audit-ip">{{ item.ip || '-' }}</span>
            </div>
            <div class="mobile-audit-time">{{ formatTime(item.createdAt) }}</div>
          </div>
          <div v-if="logs.length > 0" style="margin-top: 12px; display: flex; justify-content: center;">
            <t-pagination
              :current="pagination.current"
              :total="pagination.total"
              :page-size="pagination.pageSize"
              size="small"
              @change="onPageChange"
            />
          </div>
        </t-loading>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import MessagePlugin from '@/utils/message';
import client from '../../api/client';
import { useMobile } from '../../composables/useMobile';

interface AuditLogItem {
  id: string;
  action: string;
  userId: string | null;
  username: string | null;
  ip: string | null;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  status: string;
  createdAt: string;
}

const timeRange = ref('24h');
const filterAction = ref('');
const loading = ref(false);
const logs = ref<AuditLogItem[]>([]);
const currentPage = ref(1);
const pageSize = ref(20);
const isMobile = useMobile();

const pagination = reactive({
  current: 1,
  pageSize: 20,
  total: 0,
  showJumper: true,
  pageSizeOptions: [10, 20, 50],
});

const columns = [
  { colKey: 'action', title: '操作', width: 110 },
  { colKey: 'status', title: '状态', width: 70 },
  { colKey: 'username', title: '操作用户', ellipsis: true, width: 140 },
  { colKey: 'ip', title: 'IP', width: 130 },
  { colKey: 'resourceType', title: '资源类型', width: 90 },
  { colKey: 'resourceId', title: '资源ID', ellipsis: true, width: 140 },
  { colKey: 'metadata', title: '详情', width: 180 },
  { colKey: 'createdAt', title: '时间', width: 170 },
];

function actionLabel(action: string): string {
  const map: Record<string, string> = {
    login: '登录', login_failed: '登录失败', register: '注册',
    password_reset: '密码重置', role_change: '角色变更',
    user_create: '创建用户', user_delete: '删除用户',
    user_ban: '封禁用户', user_unban: '解封用户',
    file_upload: '文件上传', file_delete: '文件删除',
    file_delete_request: '请求删除', file_delete_by_admin: '管理员删除',
    file_restore: '文件恢复',
    file_share: '生成分享', file_password_set: '设置密码',
    file_password_remove: '移除密码', file_access_change: '访问变更',
    file_expiry_set: '有效期设置', file_download: '文件下载',
    config_change: '配置变更', smtp_config_change: 'SMTP变更',
    upload_config_change: '上传配置', auth_config_change: '认证配置',
    ip_ban: 'IP封禁', ip_unban: 'IP解封',
    batch_delete_files: '批量删除', batch_delete_files_by_admin: '管理员批量删',
    batch_markdown: '批量Markdown',
    logout: '登出', email_verify: '邮箱验证',
  };
  return map[action] || action;
}

function actionTheme(action: string): string {
  if (action.includes('login') || action === 'register') return 'primary';
  if (action.includes('delete') || action.includes('ban')) return 'danger';
  if (action.includes('config') || action.includes('role')) return 'warning';
  if (action.includes('upload') || action.includes('file')) return 'success';
  return 'default';
}

function resourceTypeLabel(type: string): string {
  const map: Record<string, string> = { user: '用户', file: '文件', config: '配置', ip: 'IP' };
  return map[type] || type;
}

function formatMetadata(meta: unknown): string {
  if (!meta) return '';
  if (typeof meta === 'string') return meta;
  try {
    if (Array.isArray(meta)) {
      return (
        meta
          .map((v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)))
          .join(', ') || '-'
      );
    }
    const obj = meta as Record<string, unknown>;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && v !== undefined) {
        parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
      }
    }
    return parts.join(', ') || '-';
  } catch {
    return String(meta);
  }
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** UUID 截断显示（前 8 位 + ...），用于无用户名的降级展示 */
function truncateId(id: string): string {
  if (id.length <= 12) return id;
  return id.substring(0, 8) + '...';
}

async function fetchLogs() {
  loading.value = true;
  try {
    const params: Record<string, unknown> = {
      page: currentPage.value,
      limit: pageSize.value,
      timeRange: timeRange.value,
    };
    if (filterAction.value) params.action = filterAction.value;

    const { data } = await client.get('/admin/audit-logs', { params });
    const d = data.data || data;
    logs.value = d.items || [];
    pagination.total = d.total || 0;
    pagination.current = currentPage.value;
    pagination.pageSize = pageSize.value;
  } catch {
    MessagePlugin.error('加载审计日志失败');
  } finally {
    loading.value = false;
  }
}

function onFilterChange() {
  currentPage.value = 1;
  fetchLogs();
}

function onPageChange(pageInfo: { current: number; pageSize: number }) {
  currentPage.value = pageInfo.current;
  pageSize.value = pageInfo.pageSize;
  fetchLogs();
}

function onRefresh() {
  fetchLogs();
}

onMounted(() => {
  fetchLogs();
});
</script>

<style scoped>
.audit-logs-page {
  padding: 0;
}

.toolbar {
  margin-bottom: 16px;
}

.table-filters {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

/* .card 容器使用全局定义，见 assets/styles.css */

@media (max-width: 768px) {
  .table-filters {
    flex-direction: column;
  }
  .table-filters > * {
    width: 100% !important;
  }
}

/* Mobile audit card */
.mobile-audit-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 10px;
}

.mobile-audit-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.mobile-audit-body {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--text-primary);
}

.mobile-audit-user {
  color: var(--text-primary);
  font-size: 13px;
}

.mobile-audit-user-id {
  font-size: 11px;
  color: var(--text-secondary);
  font-family: monospace;
}

.mobile-audit-ip {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
}

.mobile-audit-time {
  font-size: 11px;
  color: var(--text-secondary);
}
</style>
