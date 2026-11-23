<template>
  <div class="pwd-card">
    <div class="lock-icon" aria-hidden="true">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    </div>
    <h1 class="pwd-title">加密分享</h1>
    <p class="pwd-subtitle">此分享需要密码才能访问</p>

    <div v-if="errorMessage" id="share-password-error" class="error-msg" role="alert">{{ errorMessage }}</div>

    <form @submit.prevent="onSubmit" class="pwd-form">
      <label for="share-password">访问密码</label>
      <input
        id="share-password"
        ref="inputRef"
        v-model="password"
        type="password"
        placeholder="请输入访问密码"
        autocomplete="off"
        class="pwd-input"
        :disabled="loading"
        :aria-invalid="Boolean(errorMessage)"
        :aria-describedby="errorMessage ? 'share-password-error' : undefined"
      />
      <button type="submit" class="pwd-submit-btn" :disabled="loading || !password" :aria-busy="loading">
        <span v-if="loading" class="loading-spinner" aria-hidden="true" />
        <span>{{ loading ? '验证中...' : '验证' }}</span>
      </button>
    </form>

    <p class="security-hint">
      <svg class="hint-icon" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
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
  max-width: 460px;
  margin-inline: auto;
  padding: clamp(16px, 5vw, 32px);
  border: 1px solid var(--workspace-border);
  border-radius: 12px;
  background: var(--workspace-surface);
}

.lock-icon {
  display: inline-grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin-bottom: 12px;
  border-radius: 9px;
  background: var(--workspace-selected);
  color: var(--workspace-accent);
}

.pwd-title {
  margin: 0 0 8px;
  font-size: clamp(23px, 4vw, 30px);
  line-height: 1.25;
}

.pwd-subtitle,
.security-hint { color: var(--workspace-muted); }
.pwd-subtitle { margin: 0 0 20px; }

.error-msg {
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--color-danger-soft);
  color: var(--color-danger);
  overflow-wrap: anywhere;
}

.pwd-form {
  display: grid;
  gap: 8px;
  margin-bottom: 16px;
}

.pwd-form label { font-weight: 600; }

.pwd-input,
.pwd-submit-btn {
  min-width: 0;
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid var(--workspace-border);
  border-radius: 8px;
  font: inherit;
  font-size: 16px;
}

.pwd-input {
  background: var(--workspace-canvas);
  color: var(--workspace-text);
}

.pwd-input::placeholder { color: var(--workspace-muted); }
:where(.pwd-input, .pwd-submit-btn):focus-visible { outline-color: var(--workspace-accent); }

.pwd-submit-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 4px;
  border-color: var(--workspace-accent);
  background: var(--workspace-accent);
  color: var(--workspace-on-accent);
  font-weight: 600;
  cursor: pointer;
}

.pwd-submit-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--workspace-accent) 90%, var(--workspace-text));
}

.pwd-submit-btn:disabled {
  border-color: var(--workspace-border);
  background: var(--workspace-selected);
  color: var(--workspace-muted);
  cursor: not-allowed;
}

.loading-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--workspace-border);
  border-top-color: currentColor;
  border-radius: 50%;
}

@media (prefers-reduced-motion: no-preference) {
  .loading-spinner { animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
}

.security-hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  font-size: 13px;
}

.hint-icon { flex: none; margin-top: 3px; }
</style>
