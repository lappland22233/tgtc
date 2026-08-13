<template>
  <teleport to="body">
    <div
      v-if="session"
      class="mmp"
      :class="{ 'mmp--left': mediaStore.uploadPanelVisible }"
      role="region"
      aria-label="迷你播放器"
    >
      <!-- 顶部：媒体识别 + 时间 + 展开/停止 -->
      <div class="mmp__top">
        <button type="button" class="mmp__identity" @click="mediaStore.expand()">
          <span class="mmp__thumb">
            <ThumbnailImg
              :file-id="session.item.id"
              :mime-type="session.item.mimeType"
              :file-name="session.item.name"
              :size="44"
              :src="thumbnailSrc"
            />
          </span>
          <span class="mmp__info">
            <span class="mmp__name" :title="session.item.name">{{ session.item.name }}</span>
            <span class="mmp__meta">{{ kindLabel }} · {{ formatTime(currentTime) }} / {{ formatTime(duration) }}</span>
          </span>
        </button>
        <button
          type="button"
          class="mmp__btn"
          :aria-label="'展开预览 ' + session.item.name"
          title="展开预览"
          @click="mediaStore.expand()"
        >
          <t-icon name="chevron-up" />
        </button>
        <button
          type="button"
          class="mmp__btn mmp__btn--stop"
          :aria-label="'停止播放并关闭 ' + session.item.name"
          title="停止播放并关闭"
          @click="mediaStore.requestStop()"
        >
          <t-icon name="stop" />
        </button>
      </div>

      <!-- 中部：播放控制（prev / play / next） + 视频画中画 -->
      <div class="mmp__controls">
        <button
          type="button"
          class="mmp__btn mmp__btn--icon"
          :disabled="!hasPrev"
          aria-label="上一个"
          title="上一个"
          @click="mediaStore.prev()"
        >
          <t-icon name="chevron-left" />
        </button>
        <button
          type="button"
          class="mmp__btn mmp__btn--play"
          :aria-label="isPlaying ? '暂停' : '播放'"
          :title="isPlaying ? '暂停' : '播放'"
          :aria-pressed="isPlaying"
          @click="mediaStore.togglePlay()"
        >
          <t-icon :name="isPlaying ? 'pause' : 'play'" />
        </button>
        <button
          type="button"
          class="mmp__btn mmp__btn--icon"
          :disabled="!hasNext"
          aria-label="下一个"
          title="下一个"
          @click="mediaStore.next()"
        >
          <t-icon name="chevron-right" />
        </button>
        <span class="mmp__spacer" />
        <button
          v-if="session.item.kind === 'video'"
          type="button"
          class="mmp__btn mmp__btn--icon"
          :aria-pressed="mediaStore.pipActive"
          :aria-label="mediaStore.pipActive ? '退出画中画' : '进入画中画'"
          :title="mediaStore.pipActive ? '退出画中画' : '画中画'"
          @click="mediaStore.togglePiP()"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z" fill="currentColor"/>
          </svg>
        </button>
      </div>

      <!-- 底部：细进度条 -->
      <div
        class="mmp__progress"
        role="slider"
        tabindex="0"
        aria-label="播放进度"
        :aria-valuemin="0"
        :aria-valuemax="Math.max(0, Math.round(duration))"
        :aria-valuenow="Math.max(0, Math.round(currentTime))"
        :aria-valuetext="`${formatTime(currentTime)} / ${formatTime(duration)}`"
        @click="onProgressClick"
        @keydown.left.prevent="mediaStore.seekBy(-5)"
        @keydown.right.prevent="mediaStore.seekBy(5)"
      >
        <span class="mmp__progress-track">
          <span class="mmp__progress-fill" :style="{ width: progressPct + '%' }" />
        </span>
      </div>
    </div>
  </teleport>
</template>

<script setup lang="ts">
/**
 * 响应式迷你播放器 —— 完整预览收起后的浮动控制器。
 *
 * - 只消费 store 状态并向同一媒体实例发送控制命令，不创建第二个音视频元素。
 * - 桌面端默认右下角；上传浮层可见时避让到左下角。
 * - 窄屏改为底部横向控制条，避开设备安全区，保留 44px+ 触控目标。
 * - 视频额外提供画中画入口；关闭（停止）操作与「最小化」严格区分。
 */
import { computed } from 'vue';
import { useMediaPlaybackStore } from '../../stores/mediaPlayback';
import { buildShareThumbnailUrl } from '../../utils/preview';
import ThumbnailImg from '../ThumbnailImg.vue';

const mediaStore = useMediaPlaybackStore();
const session = computed(() => mediaStore.session);

const isPlaying = computed(() => mediaStore.playState === 'playing');
const currentTime = computed(() => mediaStore.currentTime);
const duration = computed(() => mediaStore.duration);
const hasPrev = computed(() => {
  const s = mediaStore.session;
  return !!s && s.playlistIndex > 0;
});
const hasNext = computed(() => {
  const s = mediaStore.session;
  return !!s && s.playlistIndex < s.playlist.length - 1;
});

const kindLabel = computed(() => {
  const kind = mediaStore.session?.item.kind;
  if (kind === 'video') return '视频';
  if (kind === 'audio') return '音频';
  return '媒体';
});

/** 分享会话下直接使用分享缩略图地址（附访问 JWT）；登录态交给 ThumbnailImg 内部构建 */
const thumbnailSrc = computed(() => {
  const s = mediaStore.session;
  if (!s) return '';
  if (s.context.type === 'share') {
    return buildShareThumbnailUrl(s.context.token, s.item.id, s.context.accessJwt || undefined);
  }
  return '';
});

const progressPct = computed(() => {
  if (duration.value <= 0 || !Number.isFinite(currentTime.value)) return 0;
  return Math.min(100, Math.max(0, (currentTime.value / duration.value) * 100));
});

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function onProgressClick(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  if (!el || duration.value <= 0) return;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return;
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  mediaStore.seekTo(pct * duration.value);
}
</script>

<style scoped>
/* ─── 浮层容器：沿用 FileCloud/Cloudscape 表面、边框与阴影 ─── */
.mmp {
  position: fixed;
  right: var(--space-4);
  bottom: calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
  z-index: 2600;
  width: min(380px, calc(100vw - var(--space-8)));
  padding: var(--space-2) var(--space-3) var(--space-2);
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  transition: right var(--duration-normal) var(--ease-out-expo),
              left var(--duration-normal) var(--ease-out-expo),
              opacity var(--duration-normal) var(--ease-out-expo),
              transform var(--duration-normal) var(--ease-out-expo);
}

/* 上传浮层可见 → 避让到左下角 */
.mmp--left {
  right: auto;
  left: var(--space-4);
}

/* ─── 顶部：媒体识别 + 时间 + 展开/停止 ─── */
.mmp__top {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.mmp__identity {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  padding: var(--space-1);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast) ease;
}

.mmp__identity:hover,
.mmp__identity:focus-visible {
  background: var(--color-bg-hover);
}

.mmp__thumb {
  display: inline-flex;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border-default);
}

.mmp__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.mmp__name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}

.mmp__meta {
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ─── 通用图标按钮 ─── */
.mmp__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  touch-action: manipulation;
  transition: background var(--duration-fast) ease, color var(--duration-fast) ease, transform 0.1s ease;
}

.mmp__btn:hover:not(:disabled) {
  background: var(--color-accent-soft);
  color: var(--text-accent);
}

.mmp__btn:active:not(:disabled) {
  transform: scale(0.92);
}

.mmp__btn:disabled {
  color: var(--text-disabled);
  cursor: default;
  opacity: 0.5;
}

.mmp__btn--stop:hover:not(:disabled) {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

/* ─── 中部控制 ─── */
.mmp__controls {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.mmp__btn--play {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--seed-primary);
  color: #fff;
  box-shadow: var(--shadow-sm);
}

.mmp__btn--play:hover {
  background: color-mix(in srgb, var(--seed-primary) 88%, #fff);
  color: #fff;
}

.mmp__spacer {
  flex: 1;
}

/* ─── 底部细进度条 ─── */
.mmp__progress {
  position: relative;
  width: 100%;
  height: 16px;
  display: flex;
  align-items: center;
  cursor: pointer;
  border-radius: 999px;
}

.mmp__progress-track {
  position: relative;
  display: block;
  width: 100%;
  height: 4px;
  background: var(--border-default);
  border-radius: 999px;
  overflow: hidden;
}

.mmp__progress-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: var(--seed-primary);
  border-radius: 999px;
}

/* ─── 窄屏：底部横向控制条 ─── */
@media (max-width: 720px) {
  .mmp,
  .mmp--left {
    right: 0;
    left: 0;
    bottom: 0;
    width: 100%;
    border-radius: var(--radius-md) var(--radius-md) 0 0;
    border-left: none;
    border-right: none;
    border-bottom: none;
    padding:
      var(--space-2)
      max(var(--space-3), env(safe-area-inset-right, 0px))
      max(var(--space-2), env(safe-area-inset-bottom, 0px))
      max(var(--space-3), env(safe-area-inset-left, 0px));
    box-shadow: 0 -8px 24px color-mix(in srgb, var(--seed-fg) 14%, transparent);
  }

  .mmp__identity {
    padding: var(--space-1);
  }

  .mmp__meta {
    display: none;
  }

  .mmp__btn {
    width: 44px;
    height: 44px;
  }

  .mmp__btn--play {
    width: 48px;
    height: 48px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .mmp {
    transition: opacity 0.01ms, transform 0.01ms;
  }
}
</style>
