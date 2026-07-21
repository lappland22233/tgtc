<template>
  <div ref="containerRef" :style="{ width: size + 'px', height: size + 'px', flexShrink: '0' }">
    <img
      v-if="signed && url"
      :src="url"
      :style="{ width: size + 'px', height: size + 'px', objectFit: 'cover', borderRadius: '6px' }"
      @error="onError"
    />
    <div
      v-else
      :style="{
        width: size + 'px',
        height: size + 'px',
        background: 'var(--bg-secondary)',
        borderRadius: '6px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.max(14, size * 0.45) + 'px',
      }"
    >
      <span v-if="mimeType?.startsWith('image/')">🖼️</span>
      <span v-else>{{ emoji }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { getThumbnailUrl } from '../utils/thumbnailCache';

const props = withDefaults(defineProps<{
  fileId: string;
  mimeType?: string;
  size?: number;
  emoji?: string;
}>(), {
  mimeType: '',
  size: 36,
  emoji: '📎',
});

const containerRef = ref<HTMLElement>();
const url = ref('');
const signed = ref(false);

let observer: IntersectionObserver | null = null;
let loaded = false;
let retried = false;   // 仅重试一次，避免错误时死循环
let unmounted = false; // 卸载后禁止再写响应式状态（异步竞态防护）

async function loadThumbnail() {
  if (loaded) return;
  loaded = true;
  try {
    const result = await getThumbnailUrl(props.fileId, props.mimeType);
    if (unmounted) return; // 组件已卸载/复用给其他 fileId，丢弃过期结果
    url.value = result;
    signed.value = true;
  } catch {
    if (unmounted) return;
    loaded = false; // 允许进入视口时再次尝试
  }
}

function onError() {
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
  if (!props.mimeType?.startsWith('image/')) return;
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
watch(() => props.fileId, () => {
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
  stopObserving();
});
</script>
