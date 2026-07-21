<template>
  <t-config-provider :global-config="globalConfig">
    <div v-if="hasError" class="error-boundary">
      <div class="error-boundary-card">
        <div class="error-icon">⚠</div>
        <h2>页面发生错误</h2>
        <p class="error-message">{{ errorMessage }}</p>
        <div class="error-actions">
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
  </t-config-provider>
</template>

<script setup lang="ts">
import { ref, onErrorCaptured, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';

const authStore = useAuthStore();

const globalConfig = {
  theme: 'dark',
};

const hasError = ref(false);
const errorMessage = ref('');

const router = useRouter();

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

<style scoped>
.error-boundary {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg);
  position: relative;
}

.error-boundary::before {
  content: '';
  position: absolute;
  width: 500px;
  height: 500px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(239, 68, 68, 0.05) 0%, transparent 70%);
  pointer-events: none;
}

.error-boundary-card {
  text-align: center;
  padding: 48px;
  background: var(--color-bg-surface);
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-default);
  max-width: 480px;
  width: 90%;
  position: relative;
  z-index: 1;
}

.error-icon {
  font-size: 48px;
  margin-bottom: 16px;
  display: block;
}

.error-boundary-card h2 {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 600;
  margin-bottom: 8px;
}

.error-message {
  color: var(--text-secondary);
  font-size: 14px;
  margin-bottom: 24px;
  word-break: break-word;
}

.error-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}
</style>
