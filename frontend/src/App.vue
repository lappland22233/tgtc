<template>
  <t-config-provider :global-config="globalConfig">
    <div v-if="hasError" class="error-boundary min-h-dvh flex items-center justify-center bg-canvas relative">
      <div class="error-boundary-card text-center p-8 sm:p-12 bg-surface rounded-xl border border-line max-w-[480px] w-[90%] relative z-[1]">
        <div class="mb-4 inline-flex justify-center">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
            <path d="M12 9v4M12 17h.01"/>
          </svg>
        </div>
        <h2 class="text-[22px] font-semibold mb-2">页面发生错误</h2>
        <p class="text-ink-muted text-[14px] mb-6 break-words">{{ errorMessage }}</p>
        <div class="flex gap-3 justify-center">
          <t-button theme="primary" @click="reload">刷新页面</t-button>
          <t-button theme="default" variant="outline" @click="goHome">返回首页</t-button>
        </div>
      </div>
    </div>
    <router-view v-else v-slot="{ Component }">
      <transition name="fade" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>
    <!-- 常驻媒体宿主：路由出口之外，保证跨导航/预览收起播放不中断 -->
    <PersistentMediaHost />
    <!-- 分享页独立于工作台，保留下载排队状态及取消入口。 -->
    <DownloadQueueIndicator v-if="hasError || !isWorkspaceRoute" />
  </t-config-provider>
</template>

<script setup lang="ts">
import { ref, computed, onErrorCaptured, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';
import { useDownloadsStore } from './stores/downloads';
import PersistentMediaHost from './components/file/PersistentMediaHost.vue';
import DownloadQueueIndicator from './components/DownloadQueueIndicator.vue';

const authStore = useAuthStore();

// TDesign globalConfig theme follows useTheme()
import { useTheme } from './composables/useTheme';
const { isDark } = useTheme();
const globalConfig = computed(() => ({
  theme: isDark.value ? 'dark' : undefined,
}));

const hasError = ref(false);
const errorMessage = ref('');

const router = useRouter();
const isWorkspaceRoute = computed(() => router.currentRoute.value.meta.requiresAuth === true);
const downloadsStore = useDownloadsStore();

// 仅监听路径变化复位错误边界：避免 query/hash 变化也触发复位导致闪烁
watch(() => router.currentRoute.value.path, () => {
  hasError.value = false;
});

onErrorCaptured((err) => {
  hasError.value = true;
  errorMessage.value = err instanceof Error ? err.message : String(err);
  console.error('[App Error Boundary]', err);
  return false;
});

// 即使工作台的传输面板关闭，返回标签页时仍需立即刷新下载队列。
onMounted(() => {
  document.addEventListener('visibilitychange', downloadsStore.refreshOnVisible);
});

onUnmounted(() => {
  document.removeEventListener('visibilitychange', downloadsStore.refreshOnVisible);
  authStore.closeAuthChannel();
});

function reload() {
  window.location.reload();
}

function goHome() {
  hasError.value = false;
  router.push('/');
}
</script>

<style scoped>
.error-boundary::before {
  content: '';
  position: absolute;
  width: 500px;
  height: 500px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--color-danger) 6%, transparent) 0%, transparent 70%);
  pointer-events: none;
}
</style>
