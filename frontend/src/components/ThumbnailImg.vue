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
import { getThumbnailUrl, getThumbnailResource, buildThumbResourceKey, releaseThumbnailResource } from '../utils/thumbnailCache';
import { acquireThumbnailSlot, releaseThumbnailSlot } from '../utils/thumbnail';
import FileTypeIcon from './FileTypeIcon.vue';

const props = withDefaults(defineProps<{
  fileId: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
  src?: string;
  /**
   * 访问上下文标识（登录 `u:<userId>` / 分享 `s:<token>`）。
   * 用于与视频预览封面共享同一份 Blob 缓存；缺省按登录态默认上下文处理。
   */
  context?: string;
  /** 内容版本（覆盖上传时递增），覆盖后使旧 Blob 缓存失效 */
  version?: string | number;
  /** @deprecated emoji prop is no longer used; kept for backward compat */
  emoji?: string;
}>(), {
  mimeType: '',
  fileName: '',
  size: 36,
  emoji: '',
  src: '',
  context: '',
});

const containerRef = ref<HTMLElement>();
const url = ref('');
const signed = ref(false);

let observer: IntersectionObserver | null = null;
let loaded = false;
let retried = false;   // 仅重试一次，避免错误时死循环
let unmounted = false; // 卸载后禁止再写响应式状态（异步竞态防护）
let slotHeld = false;
/** 代次计数：v-for 复用实例时 fileId 变化即自增，旧异步结果到达时据此丢弃（H-08 竞态防护） */
let generation = 0;
/** 当前持有的 Blob 缓存键（getThumbnailResource 已递增引用，需要配对 release） */
let activeResourceKey: string | null = null;

function releaseSlotIfHeld() {
  if (!slotHeld) return;
  slotHeld = false;
  releaseThumbnailSlot();
}

/** 释放当前持有的 Blob 资源引用 */
function releaseActiveResource() {
  if (activeResourceKey) {
    releaseThumbnailResource(activeResourceKey);
    activeResourceKey = null;
  }
}

/** 当前资源的缓存键参数（不含 URL） */
function resourceKeyParams() {
  return {
    context: props.context || 'u:default',
    fileId: props.fileId,
    version: props.version,
    hd: false,
  };
}

async function loadThumbnail() {
  if (loaded) return;
  loaded = true;
  const myGen = generation;
  await acquireThumbnailSlot();
  slotHeld = true;
  try {
    const signedUrl = props.src || (await getThumbnailUrl(props.fileId, props.mimeType));
    if (unmounted || myGen !== generation) { releaseSlotIfHeld(); return; }
    if (!signedUrl) { releaseSlotIfHeld(); return; }
    const keyParams = resourceKeyParams();
    const resource = await getThumbnailResource({
      ...keyParams,
      url: signedUrl,
    });
    // 卸载或代次变化（fileId/context/version 已切换）：丢弃本次结果，
    // 已下载的 Blob 引用释放给缓存统一管理，避免旧缩略图污染新状态。
    if (unmounted || myGen !== generation) {
      if (resource) releaseThumbnailResource(buildThumbResourceKey(keyParams));
      releaseSlotIfHeld();
      return;
    }
    if (resource) {
      activeResourceKey = buildThumbResourceKey(keyParams);
      url.value = resource.objectUrl;
      signed.value = true;
    } else {
      // 资源获取失败（下载/尺寸读取失败）：signed=false 走类型图标占位，
      // <img> 不挂载故 onLoad 不会触发，必须在此显式释放并发槽位，防止泄漏耗尽并发上限。
      signed.value = false;
      releaseSlotIfHeld();
    }
  } catch {
    releaseSlotIfHeld();
    if (unmounted || myGen !== generation) return;
    loaded = false; // 允许进入视口时再次尝试
  }
}

function onLoad() {
  releaseSlotIfHeld();
}

function onError() {
  releaseSlotIfHeld();
  releaseActiveResource();
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

// v-for 复用实例时 fileId 会变化：提升代次使在途异步结果失效，
// 重置全部加载状态并重新观察，防止旧缩略图污染新状态（H-08 竞态防护）。
watch(() => [props.fileId, props.src, props.context, props.version], () => {
  generation++;
  releaseSlotIfHeld();
  releaseActiveResource();
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
  releaseActiveResource();
  stopObserving();
});
</script>
