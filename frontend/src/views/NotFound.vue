<template>
  <div class="not-found">
    <div class="not-found-card">
      <p class="code">404</p>
      <h1>页面不存在</h1>
      <p class="hint">链接可能已失效，或地址输入有误。</p>
      <div class="actions">
        <t-button theme="primary" @click="goHome">返回首页</t-button>
        <t-button variant="outline" @click="goBack">返回上一页</t-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const auth = useAuthStore();

function goHome() {
  router.replace(auth.user ? '/files' : '/login');
}

function goBack() {
  if (window.history.length > 1) router.back();
  else goHome();
}
</script>

<style scoped>
.not-found {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: var(--space-3);
  background: var(--workspace-canvas);
  color: var(--workspace-text);
}

.not-found-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: calc(var(--space-3) * 2);
  border: 1px solid var(--workspace-border);
  border-radius: 8px;
  background: var(--workspace-surface);
  text-align: center;
}

.code {
  margin: 0;
  font-size: 40px;
  font-weight: 600;
  line-height: 1;
  opacity: 0.35;
}

.not-found-card h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.hint {
  margin: 0;
  opacity: 0.7;
}

.actions {
  display: flex;
  gap: var(--space-3);
}
</style>