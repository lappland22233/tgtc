<template>
  <div class="fpv-header">
    <div class="fpv-name" :title="name">{{ name || '文件预览' }}</div>
    <div class="fpv-header-actions">
      <!-- 播放列表导航 -->
      <template v-if="hasPlaylist && isMediaCollection">
        <span class="fpv-playlist-indicator">
          {{ activeIndex + 1 }} / {{ playlistLength }}
        </span>
        <button
          type="button"
          class="fpv-nav-btn"
          :disabled="!hasPrev"
          :aria-label="`上一个${itemLabel} (Shift+P)`"
          title="上一个 (Shift+P)"
          @click="emit('prev')"
        >
          <t-icon name="chevron-left" />
        </button>
        <button
          type="button"
          class="fpv-nav-btn"
          :disabled="!hasNext"
          :aria-label="`下一个${itemLabel} (Shift+N)`"
          title="下一个 (Shift+N)"
          @click="emit('next')"
        >
          <t-icon name="chevron-right" />
        </button>
        <!-- 注意：fpv-playlist-toggle 类名被 usePlaylistControls 用于「点击切换按钮不收起面板」判断，勿改名 -->
        <button
          type="button"
          class="fpv-nav-btn fpv-playlist-toggle"
          :class="{ 'fpv-active': playlistOpen }"
          aria-label="播放列表"
          title="播放列表"
          :aria-expanded="playlistOpen"
          aria-controls="fpv-playlist-panel"
          @click.stop="emit('toggle-playlist')"
        >
          <t-icon name="view-list" />
        </button>
      </template>
      <!-- 最小化：仅音视频持续播放时可用（其余类型等价于关闭） -->
      <button
        v-if="isContinuousMedia"
        type="button"
        class="fpv-nav-btn"
        aria-label="收起为迷你播放器（继续播放）"
        title="收起为迷你播放器（继续播放）"
        @click="emit('minimize')"
      >
        <t-icon name="chevron-down" />
      </button>
      <button type="button" class="fpv-close" aria-label="关闭预览" @click="emit('close')">
        <t-icon name="close" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 预览弹窗头部（纯展示组件，M6 从 FilePreviewDialog.vue 拆出）。
 *
 * 负责文件名、播放列表导航、最小化与关闭四类交互的呈现；
 * 不持有任何状态——播放列表开关由宿主 playlistOpen 传入，
 * 交互仅以事件回传，保证键盘快捷键与守卫逻辑仍集中在宿主。
 */
withDefaults(defineProps<{
  /** 文件名（空值回退为「文件预览」） */
  name: string;
  /** 是否存在播放列表（长度 > 1） */
  hasPlaylist: boolean;
  /** 当前媒体是否属于可导航集合（视频/音频/图片） */
  isMediaCollection: boolean;
  /** 当前播放项下标 */
  activeIndex: number;
  /** 播放列表长度 */
  playlistLength: number;
  /** 是否可切上一项 */
  hasPrev: boolean;
  /** 是否可切下一项 */
  hasNext: boolean;
  /** 播放列表面板是否展开 */
  playlistOpen: boolean;
  /** 是否为可持续播放媒体（音视频），决定是否显示「收起」 */
  isContinuousMedia: boolean;
  /** 列表项单位（如「音乐」） */
  itemLabel: string;
}>(), {
  name: '',
  itemLabel: '',
  activeIndex: -1,
  playlistLength: 0,
  hasPlaylist: false,
  isMediaCollection: false,
  hasPrev: false,
  hasNext: false,
  playlistOpen: false,
  isContinuousMedia: false,
});

const emit = defineEmits<{
  prev: [];
  next: [];
  'toggle-playlist': [];
  minimize: [];
  close: [];
}>();
</script>

<style scoped>
.fpv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.fpv-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fpv-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm, 6px);
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
  transition: background var(--duration-fast), color var(--duration-fast);
}
.fpv-close:hover {
  background: var(--color-accent-soft);
  color: var(--text-accent);
}

/* 头部右侧操作区 */
.fpv-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.fpv-playlist-indicator {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  padding: 0 6px;
  white-space: nowrap;
}

.fpv-nav-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm, 6px);
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
  transition: background var(--duration-fast), color var(--duration-fast);
}
.fpv-nav-btn:hover:not(:disabled) {
  background: var(--color-accent-soft);
  color: var(--text-accent);
}
.fpv-nav-btn:disabled {
  color: var(--text-quaternary, #999);
  cursor: default;
  opacity: 0.5;
}
.fpv-nav-btn.fpv-active {
  color: var(--seed-primary);
  background: var(--color-accent-soft);
}

@media (max-width: 720px) {
  .fpv-header {
    min-height: 48px;
    padding: 8px 10px;
  }

  .fpv-name {
    font-size: 13px;
  }

  .fpv-playlist-indicator {
    display: none;
  }

  .fpv-nav-btn,
  .fpv-close {
    width: 36px;
    height: 36px;
  }
}

@media (max-height: 560px) and (orientation: landscape) {
  .fpv-header {
    padding-block: 6px;
  }
}
</style>
