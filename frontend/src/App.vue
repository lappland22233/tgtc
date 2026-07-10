<template>
  <t-config-provider :global-config="globalConfig">
    <div v-if="hasError" style="padding: 40px; text-align: center; color: var(--text-secondary);">
      <h2>页面发生错误</h2>
      <p>{{ errorMessage }}</p>
      <div style="margin-top: 16px; display: flex; gap: 12px; justify-content: center;">
        <t-button theme="primary" @click="reload">刷新页面</t-button>
        <t-button theme="default" @click="goHome">返回首页</t-button>
      </div>
    </div>
    <router-view v-else />
  </t-config-provider>
</template>

<script setup lang="ts">
import { ref, onErrorCaptured, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';

const authStore = useAuthStore();

const globalConfig = ref({
  theme: 'dark',
});

const hasError = ref(false);
const errorMessage = ref('');

const router = useRouter();

watch(() => router.currentRoute.value, () => {
  hasError.value = false;
});

onErrorCaptured((err) => {
  hasError.value = true;
  errorMessage.value = err instanceof Error ? err.message : String(err);
  console.error('[App Error Boundary]', err);
  return false;
});

onUnmounted(() => {
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
