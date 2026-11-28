<template>
  <div class="shares-page">
    <header class="shares-header">
      <h1>我的分享</h1>
    </header>

    <div class="shares-content">
      <!-- 筛选栏 -->
      <div class="filter-bar">
        <t-radio-group v-model="filterType" aria-label="筛选分享类型" variant="default-filled" size="medium" @change="fetchShares">
          <t-radio-button value="">全部</t-radio-button>
          <t-radio-button value="file">文件</t-radio-button>
          <t-radio-button value="folder">文件夹</t-radio-button>
        </t-radio-group>
        <t-button theme="default" variant="outline" @click="fetchShares">
          <template #icon><t-icon name="refresh" /></template>
          刷新
        </t-button>
      </div>

      <!-- 加载状态 -->
      <div v-if="loading" class="share-feedback" role="status"><t-loading text="加载中..." /></div>

      <!-- G11-17：加载失败态 + 重试 -->
      <div v-else-if="loadError" class="share-feedback" role="alert">
        <div class="empty-icon feedback-error" aria-hidden="true">!</div>
        <p>{{ loadError }}</p>
        <p class="empty-hint">加载失败，请检查网络后重试</p>
        <t-button variant="outline" @click="fetchShares">重试</t-button>
      </div>

      <!-- 空状态 -->
      <div v-else-if="shares.length === 0" class="share-feedback">
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
      <ul v-else class="share-list">
        <li v-for="share in shares" :key="share.id" class="share-item">
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
              <span class="meta-tag">{{ share.targetType === 'folder' ? '文件夹' : '文件' }}</span>
              <span v-if="isEncrypted(share)" class="meta-tag share-scope">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
                加密
              </span>
              <span v-else class="meta-tag share-scope">
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
              <span class="meta-date">创建于 {{ formatDateTime(share.createdAt, true) }}</span>
            </div>
            <div class="share-url">
              <code>{{ getShareUrl(share) }}</code>
            </div>
          </div>

          <div class="share-actions">
            <t-button class="copy-action" size="small" theme="primary" variant="outline" @click="copyShareLink(share)">
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
        </li>
      </ul>

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
import { DialogPlugin } from 'tdesign-vue-next/es/dialog';
import { MessagePlugin } from 'tdesign-vue-next/es/message';
import { api } from '../../stores/auth';
import { formatDateTime } from '../../utils/format';
import { useFileStore } from '../../stores/files';
import { useFolderStore, type Folder } from '../../stores/folders';

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
/** G11-17：加载失败态（区别于“无数据”），提供重试入口 */
const loadError = ref<string | null>(null);

const fileStore = useFileStore();
const folderStore = useFolderStore();

/** 递归收集文件夹树中所有 id → name 映射，用于分享目标名称匹配（G11-16） */
function collectFolderNames(folders: Folder[], map: Map<string, string>) {
  for (const f of folders) {
    map.set(f.id, f.name);
    if (f.children?.length) collectFolderNames(f.children, map);
  }
}

/** 构建分享目标名称查找表：文件来自 fileStore 当前已加载列表，文件夹来自 folderStore 树 */
function buildTargetNameMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of fileStore.files) {
    if (f.id && f.originalName) map.set(f.id, f.originalName);
  }
  collectFolderNames(folderStore.tree, map);
  return map;
}

async function fetchShares() {
  loading.value = true;
  loadError.value = null;
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
    const msg = err?.response?.data?.message || '加载分享列表失败';
    loadError.value = msg;
    MessagePlugin.error(msg);
  } finally {
    loading.value = false;
  }
}

/**
 * G11-16：优先展示分享目标名称（后端列表若补 target 名称则直接使用，否则本地 fileStore/folderStore 匹配）。
 * 匹配不到时回退为展示 targetId 前缀 + 类型，避免只显示无意义哈希。
 */
function getTargetName(share: ShareItem): string {
  const targetName = (share as ShareItem & { targetName?: string }).targetName;
  if (targetName) return targetName;
  const name = buildTargetNameMap().get(share.targetId);
  if (name) return name;
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
  width: min(100%, 1080px);
  margin-inline: auto;
  color: var(--workspace-text);
}

.shares-header h1 {
  margin: 0 0 16px;
  font-size: clamp(24px, 4vw, 34px);
  line-height: 1.25;
}

.shares-content {
  border: 1px solid var(--workspace-border);
  border-radius: 12px;
  background: var(--workspace-surface);
  --share-gutter: clamp(10px, 3vw, 20px);
}

.filter-bar,
.share-meta,
.share-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
}

.filter-bar {
  justify-content: space-between;
  padding: 10px var(--share-gutter);
}

.share-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.share-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 8px 12px;
  padding: 12px var(--share-gutter);
  border-top: 1px solid var(--workspace-border);
}

.share-icon,
.empty-icon {
  display: inline-grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: var(--workspace-selected);
  color: var(--workspace-accent);
}

.share-icon svg { width: 20px; height: 20px; }
.share-info { min-width: 0; }
.share-name { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.share-meta { margin-block: 4px; color: var(--workspace-muted); font-size: 12px; }

.share-scope {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--workspace-accent);
}

.share-url {
  color: var(--workspace-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.share-url code { font-family: var(--font-mono); }
.share-actions { grid-column: 2; justify-content: flex-start; }
.share-actions :deep(.copy-action:hover) { background: var(--workspace-selected); }

.share-feedback {
  padding: 24px var(--share-gutter);
  border-top: 1px solid var(--workspace-border);
  overflow-wrap: anywhere;
}

.share-feedback p { margin: 8px 0; }
.share-feedback .empty-hint { color: var(--workspace-muted); }
.feedback-error { background: var(--color-danger-soft); color: var(--color-danger); }

.pagination {
  padding: 8px var(--share-gutter);
  border-top: 1px solid var(--workspace-border);
}

.pagination :deep(.t-pagination) {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 6px;
  margin: 0;
}

.pagination :deep(.t-pagination__total) { grid-area: 1 / 1 / 2 / 3; }
.pagination :deep(.t-pagination__select) { grid-area: 1 / 3; margin: 0; }
.pagination :deep(.t-pagination__btn-prev) { grid-area: 2 / 1; margin: 0; }
.pagination :deep(.t-pagination__btn-next) { grid-area: 2 / 3; margin: 0; }
.pagination :deep(.t-pagination__pager) {
  grid-area: 2 / 2;
  justify-content: center;
  flex-wrap: wrap;
  row-gap: 4px;
}

.filter-bar :deep(.t-radio-group.t-size-m .t-radio-button) {
  padding-inline: 10px;
}

.shares-content :deep(.t-button),
.filter-bar :deep(.t-radio-button),
.pagination :deep(.t-pagination__select),
.pagination :deep(.t-pagination__select .t-input) {
  min-height: 44px;
}

.pagination :deep(:is(.t-pagination__btn, .t-pagination__number)) {
  min-width: 44px;
  min-height: 44px;
}

.pagination :deep(.t-pagination__number) {
  line-height: 42px;
}

@media (min-width: 481px) {
  .filter-bar :deep(.t-radio-group.t-size-m .t-radio-button) {
    padding-inline: 16px;
  }
}

@media (min-width: 769px) {
  .share-item {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .share-actions {
    grid-column: auto;
    justify-content: flex-end;
  }

  .pagination :deep(.t-pagination) {
    display: flex;
  }

  .shares-content :deep(.t-button),
  .filter-bar :deep(.t-radio-button),
  .pagination :deep(.t-pagination__select),
  .pagination :deep(.t-pagination__select .t-input) {
    min-height: unset;
  }

  .pagination :deep(:is(.t-pagination__btn, .t-pagination__number)) {
    min-width: unset;
    min-height: unset;
  }

  .pagination :deep(.t-pagination__number) {
    line-height: normal;
  }
}

@media (pointer: coarse) {
  .shares-content :deep(.t-button),
  .filter-bar :deep(.t-radio-button),
  .pagination :deep(.t-pagination__select),
  .pagination :deep(.t-pagination__select .t-input) {
    min-height: 44px;
  }

  .pagination :deep(:is(.t-pagination__btn, .t-pagination__number)) {
    min-width: 44px;
    min-height: 44px;
  }

  .pagination :deep(.t-pagination__number) {
    line-height: 42px;
  }
}
</style>
