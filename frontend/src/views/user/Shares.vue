<template>
  <div class="shares-page">
    <div class="page-header">
      <h1>我的分享</h1>
      <p>管理您创建的所有分享链接</p>
    </div>

    <div class="card">
      <!-- 筛选栏 -->
      <div class="filter-bar">
        <t-radio-group v-model="filterType" variant="default-filled" size="medium" @change="fetchShares">
          <t-radio-button value="">全部</t-radio-button>
          <t-radio-button value="file">文件</t-radio-button>
          <t-radio-button value="folder">文件夹</t-radio-button>
        </t-radio-group>
        <t-button theme="primary" variant="outline" @click="fetchShares">
          <template #icon><t-icon name="refresh" /></template>
          刷新
        </t-button>
      </div>

      <!-- 加载状态 -->
      <t-loading v-if="loading" />

      <!-- 空状态 -->
      <div v-else-if="shares.length === 0" class="empty-state">
        <div class="empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
          </svg>
        </div>
        <p>暂无分享链接</p>
        <p class="empty-hint">在「我的文件」中选择文件，点击「分享」按钮创建分享链接</p>
      </div>

      <!-- 分享列表 -->
      <div v-else class="share-list">
        <div v-for="share in shares" :key="share.id" class="share-item" :class="{ disabled: share.isDeleted || share.status !== 'active' }">
          <div class="share-icon">
            <svg v-if="share.targetType === 'folder'" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V6z" />
            </svg>
            <svg v-else width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
          </div>

          <div class="share-info">
            <div class="share-name" :title="getTargetName(share)">
              {{ getTargetName(share) }}
            </div>
            <div class="share-meta">
              <span class="meta-tag" :class="share.targetType">{{ share.targetType === 'folder' ? '文件夹' : '文件' }}</span>
              <span v-if="isEncrypted(share)" class="meta-tag encrypted" style="display: inline-flex; align-items: center; gap: 3px;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
                加密
              </span>
              <span v-else class="meta-tag public" style="display: inline-flex; align-items: center; gap: 3px;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M2 12h20" />
                  <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
                </svg>
                公开
              </span>
              <span v-if="share.maxAccessCount >= 0" class="meta-tag">
                {{ share.currentAccessCount }}/{{ share.maxAccessCount }} 次
              </span>
              <span v-else class="meta-tag">不限次数</span>
              <span v-if="share.expiresIn" class="meta-tag">
                {{ share.expiresIn }}h 有效
              </span>
              <span v-else class="meta-tag">永久</span>
              <span class="meta-date">创建于 {{ formatDate(share.createdAt) }}</span>
            </div>
            <div class="share-url">
              <code>{{ getShareUrl(share) }}</code>
            </div>
          </div>

          <div class="share-actions">
            <t-button size="small" theme="primary" variant="outline" @click="copyShareLink(share)">
              复制链接
            </t-button>
            <t-button
              v-if="!share.isDeleted && share.status === 'active'"
              size="small"
              theme="danger"
              variant="outline"
              @click="cancelShare(share)"
            >
              取消分享
            </t-button>
            <t-tag v-else size="small" :theme="share.status === 'disabled' ? 'default' : 'warning'" variant="light">
              {{ getStatusLabel(share) }}
            </t-tag>
          </div>
        </div>
      </div>

      <!-- 分页 -->
      <div v-if="total > pageSize" class="pagination">
        <t-pagination
          v-model="page"
          :total="total"
          :page-size="pageSize"
          @change="fetchShares"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next';
import { api } from '../../stores/auth';

interface ShareItem {
  id: string;
  token: string;
  targetType: 'file' | 'folder';
  targetId: string;
  /** 是否设置了密码。后端列表应仅返回此布尔值，不返回密码原文 */
  hasPassword?: boolean;
  /** @deprecated 兼容旧接口返回的密码字段；后端改造后不再下发 */
  password?: string | null;
  maxAccessCount: number;
  currentAccessCount: number;
  expiresIn: number | null;
  expiresStartAt: string | null;
  status: 'active' | 'disabled' | 'expired' | 'exhausted';
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
}

const loading = ref(false);
const shares = ref<ShareItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const filterType = ref('');

async function fetchShares() {
  loading.value = true;
  try {
    const params: Record<string, unknown> = {
      page: page.value,
      limit: pageSize.value,
    };
    if (filterType.value) params.targetType = filterType.value;
    const res = await api.get('/shares', { params });
    const data = res.data.data;
    shares.value = data.items || [];
    total.value = data.total || 0;
  } catch (err: any) {
    MessagePlugin.error(err?.response?.data?.message || '加载分享列表失败');
  } finally {
    loading.value = false;
  }
}

function getTargetName(share: ShareItem): string {
  // 后端目前只返回 targetId，不返回 target 名称
  // Phase 4 简化：显示 targetId 的前 8 位 + 类型
  return `${share.targetType === 'folder' ? '文件夹' : '文件'} ${share.targetId.slice(0, 8)}...`;
}

// 优先读取 hasPassword；后端未改造时降级为检查 password 是否存在（不展示密码原文）
function isEncrypted(share: ShareItem): boolean {
  return share.hasPassword ?? Boolean(share.password);
}

function getShareUrl(share: ShareItem): string {
  return `${window.location.origin}/s/${share.token}`;
}

function getStatusLabel(share: ShareItem): string {
  if (share.isDeleted) return '已取消';
  switch (share.status) {
    case 'disabled': return '已禁用';
    case 'expired': return '已过期';
    case 'exhausted': return '次数耗尽';
    default: return share.status;
  }
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

async function copyShareLink(share: ShareItem) {
  try {
    await navigator.clipboard.writeText(getShareUrl(share));
    MessagePlugin.success('链接已复制到剪贴板');
  } catch {
    MessagePlugin.error('复制失败，请手动复制');
  }
}

function cancelShare(share: ShareItem) {
  const dialog = DialogPlugin.confirm({
    header: '取消分享',
    body: `确定取消此分享链接吗？取消后访问者将无法再通过此链接访问。`,
    theme: 'warning',
    confirmBtn: '取消分享',
    cancelBtn: '返回',
    onConfirm: async () => {
      try {
        await api.delete(`/shares/${share.id}`);
        MessagePlugin.success('分享已取消');
        await fetchShares();
      } catch (err: any) {
        MessagePlugin.error(err?.response?.data?.message || '取消分享失败');
      }
      dialog.destroy();
    },
    onClose: () => dialog.destroy(),
  });
}

onMounted(fetchShares);
</script>

<style scoped>
/* .page-header / .card / .empty-state 使用全局定义，见 assets/styles.css */

.shares-page {
  max-width: 960px;
  margin: 0 auto;
}

.filter-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
  gap: 12px;
}

.share-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.share-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  transition: border-color var(--duration-fast);
}

.share-item:hover {
  border-color: var(--border-accent);
}

.share-item.disabled {
  opacity: 0.6;
}

.share-icon {
  font-size: 32px;
  flex-shrink: 0;
}

.share-info {
  flex: 1;
  min-width: 0;
}

.share-name {
  font-size: 15px;
  font-weight: 500;
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.share-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
}

.meta-tag {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface);
  color: var(--text-secondary);
}

.meta-tag.file { color: var(--color-accent); }
.meta-tag.folder { color: var(--color-warning); }
.meta-tag.encrypted { color: var(--color-danger); }
.meta-tag.public { color: var(--color-success); }

.meta-date {
  font-size: 12px;
  color: var(--text-tertiary);
}

.share-url {
  font-size: 12px;
  color: var(--text-secondary);
}

.share-url code {
  font-family: var(--font-mono);
  background: var(--color-bg-surface);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  word-break: break-all;
}

.share-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.pagination {
  margin-top: 20px;
  display: flex;
  justify-content: center;
}

@media (max-width: 768px) {
  .share-item {
    flex-direction: column;
    align-items: stretch;
  }

  .share-actions {
    flex-direction: row;
    justify-content: flex-end;
  }
}
</style>
