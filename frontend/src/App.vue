<template>
  <t-config-provider :global-config="globalConfig">
    <div v-if="hasError" style="padding: 40px; text-align: center; color: var(--text-secondary);">
      <h2>页面发生错误</h2>
      <p>{{ errorMessage }}</p>
      <t-button theme="primary" @click="reload">刷新页面</t-button>
    </div>
    <router-view v-else />
  </t-config-provider>
</template>

<script setup lang="ts">
import { ref, onErrorCaptured } from 'vue';

const globalConfig = ref({
  theme: 'dark',
});

const hasError = ref(false);
const errorMessage = ref('');

onErrorCaptured((err) => {
  hasError.value = true;
  errorMessage.value = err instanceof Error ? err.message : String(err);
  console.error('[App Error Boundary]', err);
  return false; // 阻止错误继续向上传播
});

function reload() {
  window.location.reload();
}
</script>
