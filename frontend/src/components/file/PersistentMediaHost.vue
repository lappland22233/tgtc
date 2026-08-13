<template>
  <FilePreviewDialog v-if="mediaStore.session" />
  <MiniMediaPlayer v-if="mediaStore.session && !mediaStore.expanded && mediaStore.isContinuous" />
  <!-- 非打断式提示（画中画受限等），aria-live 播报，短时自动消失 -->
  <div v-if="mediaStore.errorMessage" class="mp-toast" role="status" aria-live="polite">
    <t-icon name="info-circle" class="mp-toast__icon" aria-hidden="true" />
    <span>{{ mediaStore.errorMessage }}</span>
  </div>
</template>

<script setup lang="ts">
/**
 * 常驻媒体宿主 —— 挂载在 App.vue 路由出口之外。
 *
 * 持有全局唯一的预览会话：完整预览（FilePreviewDialog）与迷你播放器
 * （MiniMediaPlayer）是同一媒体会话的两种展示形态，切换形态不卸载媒体实例，
 * 因此路由导航、文件夹切换、预览收起都不会中断播放。
 */
import { watch } from 'vue';
import { useAuthStore } from '../../stores/auth';
import { useMediaPlaybackStore } from '../../stores/mediaPlayback';
import FilePreviewDialog from './FilePreviewDialog.vue';
import MiniMediaPlayer from './MiniMediaPlayer.vue';

const mediaStore = useMediaPlaybackStore();
const authStore = useAuthStore();

// 登出 / 会话失效时终止媒体会话（分享媒体遇到 401 会由播放器进入错误态，此处覆盖登录态切换）
watch(() => authStore.user, (user) => {
  if (!user) mediaStore.requestStop();
});
</script>

<style scoped>
/* 非打断式提示：桌面右下、窄屏顶部居中，避开迷你播放器与上传浮层 */
.mp-toast {
  position: fixed;
  right: var(--space-4);
  bottom: calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
  z-index: 2700;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: min(360px, calc(100vw - var(--space-8)));
  padding: var(--space-2) var(--space-4);
  background: var(--color-bg-surface);
  border: 1px solid var(--border-accent);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  font-size: 13px;
  color: var(--text-primary);
  pointer-events: none;
}

.mp-toast__icon {
  color: var(--seed-primary);
  flex-shrink: 0;
}

@media (max-width: 720px) {
  .mp-toast {
    right: var(--space-3);
    left: var(--space-3);
    bottom: auto;
    top: max(var(--space-3), env(safe-area-inset-top, 0px));
    max-width: none;
  }
}
</style>
