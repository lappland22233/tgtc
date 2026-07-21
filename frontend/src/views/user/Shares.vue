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
        <div class="empty-icon">🔗</div>
        <p>暂无分享链接</p>
        <p class="empty-hint">在「我的文件」中选择文件，点击「分享」按钮创建分享链接</p>
      </div>

      <!-- 分享列表 -->
      <div v-else class="share-list">
        <div v-for="share in shares" :key="share.id" class="share-item" :class="{ disabled: share.isDeleted || share.status !== 'active' }">
          <div class="share-icon">
            {{ share.targetType === 'folder' ? '📁' : '📄' }}
          </div>

          <div class="share-info">
            <div class="share-name" :title="getTargetName(share)">
              {{ getTargetName(share) }}
            </div>
            <div class="share-meta">
              <span class="meta-tag" :class="share.targetType">{{ share.targetType === 'folder' ? '文件夹' : '文件' }}</span>
              <span v-if="share.password" class="meta-tag encrypted">🔒 加密</span>
              <span v-else class="meta-tag public">🌐 公开</span>
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
  password: string | null;
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
.shares-page {
  max-width: 960px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 20px;
}

.page-header h1 {
  font-size: 24px;
  font-weight: 600;
  margin: 0 0 4px;
}

.page-header p {
  color: var(--td-text-color-secondary);
  font-size: 14px;
  margin: 0;
}

.card {
  background: var(--td-bg-color-container);
  border: 1px solid var(--td-border-level-2-color);
  border-radius: 8px;
  padding: 20px;
}

.filter-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
  gap: 12px;
}

.empty-state {
  text-align: center;
  padding: 48px 0;
  color: var(--td-text-color-secondary);
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 12px;
}

.empty-hint {
  font-size: 13px;
  color: var(--td-text-color-placeholder);
  margin-top: 8px;
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
  background: var(--td-bg-color-secondarycontainer);
  border: 1px solid var(--td-border-level-1-color);
  border-radius: 8px;
  transition: border-color 0.2s;
}

.share-item:hover {
  border-color: var(--td-brand-color);
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
  border-radius: 4px;
  background: var(--td-bg-color-container);
  color: var(--td-text-color-secondary);
}

.meta-tag.file { color: var(--td-brand-color); }
.meta-tag.folder { color: var(--td-warning-color); }
.meta-tag.encrypted { color: var(--td-error-color); }
.meta-tag.public { color: var(--td-success-color); }

.meta-date {
  font-size: 12px;
  color: var(--td-text-color-placeholder);
}

.share-url {
  font-size: 12px;
  color: var(--td-text-color-secondary);
}

.share-url code {
  font-family: 'SFMono-Regular', Consolas, monospace;
  background: var(--td-bg-color-container);
  padding: 2px 6px;
  border-radius: 4px;
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
</style>
