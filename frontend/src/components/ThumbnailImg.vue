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
import { ref, onMounted, onUnmounted } from 'vue';
import { buildThumbUrl } from '../utils/thumbnail';

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
let signedOnce = false;

async function loadThumbnail() {
  if (signedOnce) return;
  signedOnce = true;
  try {
    url.value = await buildThumbUrl(props.fileId);
    signed.value = true;
  } catch {
    // 签名失败，保持占位图
  }
}

function onError() {
  url.value = '';
  signed.value = false;
}

onMounted(() => {
  // 仅处理图片类型
  if (!props.mimeType?.startsWith('image/')) return;
  if (!containerRef.value) return;

  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) {
        loadThumbnail();
        observer?.disconnect();
      }
    },
    { rootMargin: '200px' },
  );
  observer.observe(containerRef.value);
});

onUnmounted(() => {
  observer?.disconnect();
});
</script>
