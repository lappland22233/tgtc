<template>
  <div v-if="store.hasActiveJobs" class="download-queue" role="status" aria-live="polite">
    <div class="download-queue__header">
      <span class="download-queue__title">
        下载队列（{{ store.jobs.length }}）
      </span>
      <span class="download-queue__hint">{{ headerHint }}</span>
    </div>
    <ul class="download-queue__list">
      <li v-for="job in store.jobs" :key="job.taskId" class="download-queue__item">
        <div class="download-queue__row">
          <FileTypeIcon :fileName="job.fileName" :size="18" />
          <span class="download-queue__name" :title="job.fileName">{{ job.fileName }}</span>
        </div>
        <div class="download-queue__row download-queue__row--meta">
          <span class="download-queue__status" :class="statusClass(job)">
            <svg v-if="job.status === 'queued'" class="download-queue__spinner" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="42 60" />
            </svg>
            <svg v-else-if="job.status === 'streamable'" class="download-queue__icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
            <svg v-else class="download-queue__icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3 2 20h20L12 3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
              <path d="M12 10v4M12 17h.01" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
            <span class="download-queue__status-text">{{ downloadStatusLabel(job) }}</span>
          </span>
          <button
            v-if="job.status === 'queued'"
            type="button"
            class="download-queue__cancel"
            :aria-label="`取消下载 ${job.fileName}`"
            @click="store.cancel(job.taskId)"
          >
            取消
          </button>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import FileTypeIcon from './FileTypeIcon.vue';
import { useDownloadsStore, downloadStatusLabel, type DownloadJob } from '../stores/downloads';

const store = useDownloadsStore();

/** 头部提示：排队时说明原因，就绪/直通时说明正在交给浏览器下载 */
const headerHint = computed(() => {
  if (store.queuedJobs.length > 0) {
    const reason = store.queuedJobs[0]?.queueReason;
    return reason === 'upstream' ? '下载连接繁忙，等待中' : '服务器资源紧张，排队中';
  }
  if (store.jobs.some(job => job.status === 'streamable' && job.mode === 'direct')) {
    return '直通下载（不占本地缓存）';
  }
  if (store.jobs.some(job => job.status === 'streamable')) {
    return '已就绪，正在交给浏览器下载';
  }
  return '下载任务已结束';
});

/** 状态样式修饰：按状态区分（排队/就绪/直通/中断/过期） */
function statusClass(job: DownloadJob): string {
  return `download-queue__status--${job.status}${job.mode === 'direct' ? ' download-queue__status--direct' : ''}`;
}

function handleVisibility(): void {
  store.refreshOnVisible();
}

onMounted(() => {
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibility);
  }
});

onUnmounted(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibility);
  }
});
</script>

<style scoped>
.download-queue {
  position: fixed;
  right: var(--space-4);
  bottom: var(--space-4);
  z-index: 1000;
  width: 320px;
  max-width: calc(100vw - var(--space-8));
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  box-shadow: var(--shadow-lg);
}

.download-queue__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.download-queue__title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.download-queue__hint {
  font-size: 11px;
  color: var(--text-tertiary);
}

.download-queue__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 220px;
  overflow-y: auto;
}

.download-queue__item {
  padding: var(--space-2);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--color-bg-overlay);
}

.download-queue__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.download-queue__row--meta {
  margin-top: var(--space-1);
  justify-content: space-between;
}

.download-queue__name {
  overflow: hidden;
  font-size: 13px;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.download-queue__status {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: 12px;
  color: var(--text-secondary);
}

.download-queue__spinner {
  width: 12px;
  height: 12px;
  flex: none;
  color: var(--seed-primary);
  animation: download-queue-spin 1.2s linear infinite;
}

.download-queue__icon {
  width: 12px;
  height: 12px;
  flex: none;
  color: var(--seed-primary);
}

.download-queue__status-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 状态用「图标 + 文案 + 颜色」三重表达，不依赖单一颜色 */
.download-queue__status--streamable { color: var(--color-success); }
.download-queue__status--streamable .download-queue__icon { color: var(--color-success); }
.download-queue__status--streamable.download-queue__status--direct { color: var(--seed-primary); }
.download-queue__status--streamable.download-queue__status--direct .download-queue__icon { color: var(--seed-primary); }
.download-queue__status--expired { color: var(--color-warning); }
.download-queue__status--expired .download-queue__icon { color: var(--color-warning); }
.download-queue__status--cancelled { color: var(--text-tertiary); }
.download-queue__status--cancelled .download-queue__icon { color: var(--text-tertiary); }

@keyframes download-queue-spin {
  to {
    transform: rotate(360deg);
  }
}

.download-queue__cancel {
  flex: none;
  min-height: 24px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out-expo), border-color var(--duration-fast) var(--ease-out-expo);
}

.download-queue__cancel:hover {
  border-color: var(--border-accent);
  color: var(--seed-primary);
}

.download-queue__cancel:focus-visible {
  outline: 2px solid var(--seed-primary);
  outline-offset: 2px;
}

@media (max-width: 768px) {
  .download-queue {
    right: var(--space-2);
    bottom: var(--space-2);
    left: var(--space-2);
    width: auto;
  }

  .download-queue__cancel {
    min-height: 44px;
    min-width: 64px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .download-queue__spinner {
    animation: none;
  }
}
</style>
