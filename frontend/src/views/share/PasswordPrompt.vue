<template>
  <div class="pwd-card">
    <div class="lock-icon-wrapper">
      <div class="lock-icon">🔒</div>
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
      💡 严格模式密码保护：未通过验证前不会显示任何文件信息
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
  background: #21262D;
  border: 1px solid #30363D;
  border-radius: 16px;
  padding: 48px 40px;
  width: 100%;
  max-width: 420px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  text-align: center;
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: #E6EDF3;
}

.lock-icon-wrapper {
  margin-bottom: 20px;
}

.lock-icon {
  font-size: 56px;
  display: inline-block;
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
  color: #E6EDF3;
}

.pwd-subtitle {
  color: #8B949E;
  font-size: 14px;
  margin: 0 0 28px;
}

.error-msg {
  background: rgba(248, 81, 73, 0.13);
  color: #F85149;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
  margin-bottom: 16px;
  border: 1px solid rgba(248, 81, 73, 0.3);
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
  background: #0D1117;
  border: 1px solid #30363D;
  border-radius: 8px;
  color: #E6EDF3;
  font-size: 16px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s, box-shadow 0.2s;
  font-family: inherit;
}

.pwd-input:focus {
  border-color: #0052D9;
  box-shadow: 0 0 0 3px rgba(0, 82, 217, 0.2);
}

.pwd-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.pwd-submit-btn {
  width: 100%;
  padding: 14px;
  background: #0052D9;
  color: #fff;
  border: none;
  border-radius: 8px;
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
  background: #0969DA;
}

.pwd-submit-btn:active:not(:disabled) {
  transform: scale(0.98);
}

.pwd-submit-btn:disabled {
  background: #30363D;
  color: #8B949E;
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
  color: #6E7681;
  font-size: 12px;
  margin: 0;
  line-height: 1.5;
}
</style>
