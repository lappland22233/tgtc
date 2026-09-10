<template>
  <transition name="fpv-slide">
    <div
      v-if="visible"
      id="fpv-playlist-panel"
      ref="panelEl"
      class="fpv-playlist-panel"
      role="region"
      :aria-label="title"
    >
      <div class="fpv-playlist-header">
        <span class="fpv-playlist-title">{{ title }}</span>
        <span class="fpv-playlist-count">{{ items.length }} 个{{ itemLabel }}</span>
        <button
          type="button"
          class="fpv-playlist-close"
          aria-label="收起播放列表"
          title="收起播放列表"
          @click="emit('update:open', false)"
        >
          <t-icon name="close" />
        </button>
      </div>
      <div class="fpv-playlist-list">
        <button
          v-for="(item, idx) in items"
          :key="item.id"
          type="button"
          class="fpv-playlist-item"
          :class="{ 'fpv-playing': idx === activeIndex, 'fpv-playlist-item--image': kind === 'image' }"
          :aria-current="idx === activeIndex ? 'true' : undefined"
          :aria-label="`${idx === activeIndex ? '当前播放：' : '播放'}${item.name}`"
          @click="emit('switch', idx)"
        >
          <ThumbnailImg
            v-if="kind === 'image'"
            class="fpv-playlist-thumb"
            :file-id="item.id"
            :mime-type="item.mimeType"
            :file-name="item.name"
            :size="48"
            :context="thumbContext"
            :version="item.contentVersion"
          />
          <div v-else class="fpv-playlist-index">{{ idx + 1 }}</div>
          <div class="fpv-playlist-info">
            <div class="fpv-playlist-name" :title="item.name">{{ item.name }}</div>
            <div class="fpv-playlist-meta">
              {{ item.mimeType }}<template v-if="item.size"> · {{ formatSize(item.size) }}</template>
            </div>
          </div>
          <div v-if="idx === activeIndex" class="fpv-playlist-now">
            <t-icon name="sound" />
          </div>
        </button>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
/**
 * 播放列表面板（纯展示组件，M6 从 FilePreviewDialog.vue 拆出）。
 *
 * 状态与行为仍由宿主 + usePlaylistControls 持有：本组件只负责渲染列表、
 * 回传「收起」与「切换到第 N 项」两个意图，不访问 store、不发请求。
 *
 * 可见性同时受 open 与列表长度约束（长度 > 1 才有意义），与拆分前
 * `v-if="playlistOpen && hasPlaylist"` 完全一致。
 */
import { computed, ref } from 'vue';
import ThumbnailImg from '../ThumbnailImg.vue';
import { formatSizeCompact as formatSize } from '../../utils/format';
import type { MediaSessionItem } from '../../stores/mediaPlayback';
import type { PreviewKind } from '../../utils/preview';

const props = defineProps<{
  /** 是否展开（v-model:open 由宿主的 playlistOpen 驱动） */
  open: boolean;
  /** 播放列表（与当前媒体同类别） */
  items: MediaSessionItem[];
  /** 当前播放项下标；-1 表示无 */
  activeIndex: number;
  /** 当前媒体类别；仅影响图片项的缩略图渲染 */
  kind: PreviewKind | null;
  /** 面板标题（如「音乐播放列表」） */
  title: string;
  /** 列表项单位（如「音乐」） */
  itemLabel: string;
  /** 缩略图访问上下文标识（ThumbnailImg context） */
  thumbContext: string;
}>();

const emit = defineEmits<{
  'update:open': [open: boolean];
  switch: [index: number];
}>();

/** 供宿主判断「点击是否落在面板内」（usePlaylistControls 的点击外部收起） */
const panelEl = ref<HTMLElement | null>(null);

const visible = computed(() => props.open && props.items.length > 1);

defineExpose({ panelEl });
</script>

<style scoped>
/* 播放列表面板 */
.fpv-playlist-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 280px;
  max-width: 80%;
  background: var(--color-bg-overlay);
  border-left: 1px solid var(--border-default);
  display: flex;
  flex-direction: column;
  z-index: 10;
}

.fpv-playlist-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.fpv-playlist-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.fpv-playlist-count {
  font-size: 11px;
  color: var(--text-tertiary);
}

.fpv-playlist-close {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  margin-left: auto;
  border: 0;
  border-radius: var(--radius-sm, 6px);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.fpv-playlist-close:hover {
  background: var(--color-accent-soft);
  color: var(--text-accent);
}

.fpv-playlist-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
  scrollbar-width: thin;
  scrollbar-color: var(--border-default) transparent;
}
.fpv-playlist-list::-webkit-scrollbar { width: 4px; }
.fpv-playlist-list::-webkit-scrollbar-track { background: transparent; }
.fpv-playlist-list::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 2px; }

.fpv-playlist-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 14px;
  border: 0;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
  position: relative;
  color: var(--text-primary);
}
.fpv-playlist-item:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
.fpv-playlist-item:hover {
  background: var(--color-accent-soft);
}
.fpv-playlist-item.fpv-playing {
  background: color-mix(in srgb, var(--seed-primary) 8%, transparent);
}
.fpv-playlist-item.fpv-playing::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  background: var(--seed-primary);
  border-radius: 0 2px 2px 0;
}

.fpv-playlist-thumb {
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  object-fit: cover;
  border-radius: var(--radius-sm, 6px);
  background: var(--color-bg-secondary);
  border: 1px solid var(--border-default);
}

.fpv-playlist-item--image {
  min-height: 64px;
}

.fpv-playlist-index {
  width: 20px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-quaternary, #999);
  text-align: center;
  flex-shrink: 0;
  font-family: var(--font-mono);
}

.fpv-playlist-info {
  flex: 1;
  min-width: 0;
}

.fpv-playlist-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}
.fpv-playing .fpv-playlist-name {
  color: var(--seed-primary);
}

.fpv-playlist-meta {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fpv-playlist-now {
  color: var(--seed-primary);
  font-size: 16px;
  flex-shrink: 0;
}

/* 播放列表滑入动画 */
.fpv-slide-enter-active,
.fpv-slide-leave-active {
  transition: transform var(--duration-fast, 0.15s) ease, opacity var(--duration-fast, 0.15s) ease;
}
.fpv-slide-enter-from,
.fpv-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

@media (max-width: 720px) {
  .fpv-playlist-panel {
    top: auto;
    width: 100%;
    max-width: none;
    max-height: min(62%, 520px);
    border-top: 1px solid var(--border-default);
    border-left: 0;
    box-shadow: 0 -12px 32px rgba(0, 0, 0, 0.28);
  }

  .fpv-slide-enter-from,
  .fpv-slide-leave-to {
    transform: translateY(100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .fpv-slide-enter-active,
  .fpv-slide-leave-active {
    transition: none;
  }
}
</style>
