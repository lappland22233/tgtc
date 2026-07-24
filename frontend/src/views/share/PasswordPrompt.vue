<template>
  <div class="pwd-card">
    <div class="lock-icon-wrapper">
      <div class="lock-icon">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
    </div>
    <h1 class="pwd-title">加密分享</h1>
    <p class="pwd-subtitle">此分享需要密码才能访问</p>

    <div v-if="errorMessage" class="error-msg">{{ errorMessage }}</div>

    <form @submit.prevent="onSubmit" class="pwd-form">
      <input
        ref="inputRef"
        v-model="password"
        type="password"
        placeholder="请输入访问密码"
        autocomplete="off"
        class="pwd-input"
        :disabled="loading"
      />
      <button type="submit" class="pwd-submit-btn" :disabled="loading || !password">
        <span v-if="loading" class="loading-spinner" />
        <span>{{ loading ? '验证中...' : '验证' }}</span>
      </button>
    </form>

    <p class="security-hint">
      <svg class="hint-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <path d="M12 16v-4"/>
        <path d="M12 8h.01"/>
      </svg>
      严格模式密码保护：未通过验证前不会显示任何文件信息
    </p>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';

const props = defineProps<{
  errorMessage?: string;
  loading?: boolean;
}>();

const emit = defineEmits<{ submit: [password: string] }>();

const password = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

function onSubmit() {
  if (!password.value || props.loading) return;
  emit('submit', password.value);
}

// 自动聚焦输入框
onMounted(() => {
  setTimeout(() => inputRef.value?.focus(), 100);
});

// errorMessage 变化时清空密码（方便用户重新输入）
watch(() => props.errorMessage, (v) => {
  if (v) {
    password.value = '';
    setTimeout(() => inputRef.value?.focus(), 50);
  }
});
</script>

<style scoped>
.pwd-card {
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: 48px 40px;
  width: 100%;
  max-width: 420px;
  box-shadow: var(--shadow-lg);
  text-align: center;
  font-family: var(--font-body);
  color: var(--text-primary);
}

.lock-icon-wrapper {
  margin-bottom: 20px;
}

.lock-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--seed-primary);
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.05); opacity: 0.85; }
}

.pwd-title {
  font-size: 22px;
  font-weight: 600;
  margin: 0 0 8px;
  color: var(--text-primary);
}

.pwd-subtitle {
  color: var(--text-secondary);
  font-size: 14px;
  margin: 0 0 28px;
}

.error-msg {
  background: var(--color-danger-soft);
  color: var(--color-danger);
  padding: 10px 14px;
  border-radius: var(--radius-md);
  font-size: 13px;
  margin-bottom: 16px;
  border: 1px solid color-mix(in srgb, var(--color-danger) 30%, transparent);
}

.pwd-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 24px;
}

.pwd-input {
  width: 100%;
  padding: 14px 16px;
  background: var(--color-bg);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: 16px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s, box-shadow 0.2s;
  font-family: inherit;
}

.pwd-input:focus {
  border-color: var(--seed-primary);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.pwd-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.pwd-submit-btn {
  width: 100%;
  padding: 14px;
  background: var(--seed-primary);
  color: #fff;
  border: none;
  border-radius: var(--radius-md);
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s, transform 0.1s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-family: inherit;
}

.pwd-submit-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--seed-primary) 85%, #fff);
}

.pwd-submit-btn:active:not(:disabled) {
  transform: scale(0.98);
}

.pwd-submit-btn:disabled {
  background: var(--border-default);
  color: var(--text-secondary);
  cursor: not-allowed;
}

.loading-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.security-hint {
  color: var(--text-tertiary);
  font-size: 12px;
  margin: 0;
  line-height: 1.5;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.hint-icon {
  flex-shrink: 0;
}
</style>
