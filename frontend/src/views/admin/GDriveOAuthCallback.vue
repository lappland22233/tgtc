<template>
  <div class="oauth-callback-container">
    <div class="oauth-card">
      <div class="status-icon-wrapper" :class="status">
        <svg v-if="status === 'success'" class="status-svg" viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="22" fill="var(--color-success-soft)" stroke="var(--color-success)" stroke-width="3" />
          <path d="M15 24.5L21 30.5L33 18" stroke="var(--color-success)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else-if="status === 'error'" class="status-svg" viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="22" fill="var(--color-danger-soft)" stroke="var(--color-danger)" stroke-width="3" />
          <path d="M17 17L31 31M31 17L17 31" stroke="var(--color-danger)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <div v-else class="status-spinner" />
      </div>

      <h2 class="title">{{ titleText }}</h2>
      <p class="subtitle">{{ subtitleText }}</p>

      <div v-if="status === 'error' && errorMessage" class="error-box">
        {{ errorMessage }}
      </div>

      <div class="actions">
        <button v-if="isPopup" class="btn btn-secondary" @click="closeWindow">关闭窗口</button>
        <button class="btn btn-primary" @click="goToStorageBackends">返回存储管理</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';

export type CallbackStatus = 'pending' | 'success' | 'error';

const router = useRouter();
const status = ref<CallbackStatus>('pending');
const errorMessage = ref('');
const isPopup = ref(false);

const titleText = computed(() => {
  if (status.value === 'success') return '已收到 Google Drive 授权码';
  if (status.value === 'error') return 'Google Drive 授权失败';
  return '正在处理 Google 授权...';
});

const subtitleText = computed(() => {
  if (status.value === 'success') {
    return isPopup.value
      ? '授权码已回传，请以管理后台的兑换结果为准。'
      : '请返回管理后台查看凭据兑换结果。';
  }
  if (status.value === 'error') {
    return '未能完成授权，请检查错误信息或重试。';
  }
  return '正在接收来自 Google 的重定向凭据并校验一致性...';
});

function closeWindow() {
  window.close();
}

function goToStorageBackends() {
  router.push('/admin/storage-backends');
}

onMounted(() => {
  isPopup.value = Boolean(window.opener && window.opener !== window);

  const searchParams = new URLSearchParams(window.location.search);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  const ok = Boolean(code?.trim() && state?.trim() && !error);
  status.value = ok ? 'success' : 'error';
  errorMessage.value = ok ? '' : errorDescription || error || '授权码或授权状态缺失，请重新发起授权';
  const payload = {
    type: 'TGTC_GDRIVE_OAUTH_RESULT',
    status: status.value,
    state: state?.trim(),
    ...(ok ? { code: code!.trim() } : { error: errorMessage.value }),
  };
  try {
    window.opener?.postMessage(payload, window.location.origin);
  } catch {}
  try {
    const bc = new BroadcastChannel('tgtc_gdrive_oauth_channel');
    bc.postMessage(payload);
    bc.close();
  } catch {}
  try {
    // Other windows receive the set event's newValue even after immediate removal.
    // Closing this popup cannot leave an unused code on disk.
    localStorage.setItem('tgtc_gdrive_oauth_event', JSON.stringify(payload));
    localStorage.removeItem('tgtc_gdrive_oauth_event');
  } catch {}
  if (!ok) return;

  // 如果是在弹窗中打开的，1.2 秒后自动关闭
  if (isPopup.value) {
    setTimeout(() => {
      try {
        window.close();
      } catch {}
    }, 1200);
  }
});
</script>

<style scoped>
.oauth-callback-container {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: clamp(12px, 4vw, 24px);
  background: var(--workspace-canvas);
  color: var(--workspace-text);
}

.oauth-card {
  width: 100%;
  max-width: 440px;
  background: var(--workspace-surface);
  border-radius: 12px;
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--workspace-border);
  padding: 28px clamp(16px, 5vw, 28px);
  text-align: center;
}

.status-icon-wrapper {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-bottom: 20px;
}

.status-svg {
  width: 56px;
  height: 56px;
}

.status-spinner {
  width: 44px;
  height: 44px;
  border: 4px solid var(--workspace-selected);
  border-top-color: var(--workspace-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.title {
  margin: 0 0 8px;
  font-size: 20px;
  font-weight: 600;
  color: var(--workspace-text);
}

.subtitle {
  margin: 0 0 20px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--workspace-muted);
  overflow-wrap: anywhere;
}

.error-box {
  margin-bottom: 20px;
  padding: 10px 14px;
  font-size: 13px;
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border-radius: 6px;
  overflow-wrap: anywhere;
  text-align: left;
}

.actions {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
}

.btn {
  min-height: 44px;
  padding: 8px 18px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  border: 1px solid transparent;
}

.btn-primary {
  background: var(--workspace-accent);
  color: var(--workspace-on-accent);
}

.btn-primary:hover {
  background: color-mix(in srgb, var(--workspace-accent) 86%, var(--workspace-text));
}

.btn-secondary {
  background-color: transparent;
  color: var(--workspace-text);
  border-color: var(--workspace-border);
}

.btn-secondary:hover {
  background: var(--workspace-selected);
}

.btn:focus-visible {
  outline: 2px solid var(--workspace-accent);
  outline-offset: 2px;
}
</style>
