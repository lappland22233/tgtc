<template>
  <div ref="containerRef" :style="{ width: size + 'px', height: size + 'px', flexShrink: '0' }">
    <img
      v-if="signed && url"
      :src="url"
      :style="{ width: size + 'px', height: size + 'px', objectFit: 'cover', borderRadius: 'var(--radius-sm, 4px)' }"
      @load="onLoad"
      @error="onError"
    />
    <FileTypeIcon
      v-else
      :mimeType="mimeType"
      :fileName="fileName"
      :size="size"
      with-bg
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { getThumbnailUrl } from '../utils/thumbnailCache';
import { acquireThumbnailSlot, releaseThumbnailSlot } from '../utils/thumbnail';
import FileTypeIcon from './FileTypeIcon.vue';

const props = withDefaults(defineProps<{
  fileId: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
  src?: string;
  /** @deprecated emoji prop is no longer used; kept for backward compat */
  emoji?: string;
}>(), {
  mimeType: '',
  fileName: '',
  size: 36,
  emoji: '',
  src: '',
});

const containerRef = ref<HTMLElement>();
const url = ref('');
const signed = ref(false);

let observer: IntersectionObserver | null = null;
let loaded = false;
let retried = false;   // 仅重试一次，避免错误时死循环
let unmounted = false; // 卸载后禁止再写响应式状态（异步竞态防护）
let slotHeld = false;

function releaseSlotIfHeld() {
  if (!slotHeld) return;
  slotHeld = false;
  releaseThumbnailSlot();
}

async function loadThumbnail() {
  if (loaded) return;
  loaded = true;
  await acquireThumbnailSlot();
  slotHeld = true;
  try {
    const result = await getThumbnailUrl(props.fileId, props.mimeType, props.src);
    if (unmounted) { releaseSlotIfHeld(); return; }
    url.value = result;
    signed.value = true;
  } catch {
    releaseSlotIfHeld();
    if (unmounted) return;
    loaded = false; // 允许进入视口时再次尝试
  }
}

function onLoad() {
  releaseSlotIfHeld();
}

function onError() {
  releaseSlotIfHeld();
  url.value = '';
  signed.value = false;
  // 一次性重试：签名 URL 可能已过期（缓存 TTL 很短），重新构建通常可恢复
  if (!retried && !unmounted) {
    retried = true;
    loaded = false;
    loadThumbnail();
  }
}

function stopObserving() {
  observer?.disconnect();
  observer = null;
}

function startObserving() {
  stopObserving();
  if (!props.mimeType?.startsWith('image/') && !props.mimeType?.startsWith('video/')) return;
  if (!containerRef.value) return;

  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) {
        loadThumbnail();
        stopObserving();
      }
    },
    { rootMargin: '300px' },
  );
  observer.observe(containerRef.value);
}

// v-for 复用实例时 fileId 会变化：重置全部加载状态并重新观察，
// 否则会显示上一个文件的旧缩略图
watch(() => [props.fileId, props.src], () => {
  releaseSlotIfHeld();
  loaded = false;
  retried = false;
  url.value = '';
  signed.value = false;
  startObserving();
});

onMounted(() => {
  startObserving();
});

onUnmounted(() => {
  unmounted = true;
  releaseSlotIfHeld();
  stopObserving();
});
</script>
