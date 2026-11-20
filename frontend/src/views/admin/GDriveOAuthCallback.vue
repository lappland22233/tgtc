<template>
  <div class="oauth-callback-container">
    <div class="oauth-card">
      <div class="status-icon-wrapper" :class="status">
        <svg v-if="status === 'success'" class="status-svg" viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="22" fill="#E8F8F2" stroke="#00A870" stroke-width="3" />
          <path d="M15 24.5L21 30.5L33 18" stroke="#00A870" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else-if="status === 'error'" class="status-svg" viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="22" fill="#FEECEC" stroke="#E34D59" stroke-width="3" />
          <path d="M17 17L31 31M31 17L17 31" stroke="#E34D59" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />
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
  if (status.value === 'success') return 'Google Drive 授权成功';
  if (status.value === 'error') return 'Google Drive 授权失败';
  return '正在处理 Google 授权...';
});

const subtitleText = computed(() => {
  if (status.value === 'success') {
    return isPopup.value
      ? '凭据正在同步至 TGTC 管理后台，此窗口即将自动关闭...'
      : '凭据已获取，请返回管理后台查看。';
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

  if (error || !code) {
    status.value = 'error';
    errorMessage.value = errorDescription || error || '未在回调地址中检测到有效的授权码（code）';

    const failPayload = {
      type: 'TGTC_GDRIVE_OAUTH_RESULT',
      status: 'error',
      error: errorMessage.value,
      state: state || undefined,
    };

    // 1. postMessage 回传
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage(failPayload, window.location.origin);
      } catch (e) {
        console.warn('[GDriveOAuth] postMessage failed:', e);
      }
    }

    // 2. BroadcastChannel 回传
    try {
      const bc = new BroadcastChannel('tgtc_gdrive_oauth_channel');
      bc.postMessage(failPayload);
      bc.close();
    } catch {}

    // 3. localStorage 事件回传
    try {
      localStorage.setItem('tgtc_gdrive_oauth_event', JSON.stringify({
        ...failPayload,
        timestamp: Date.now(),
      }));
      setTimeout(() => {
        try {
          localStorage.removeItem('tgtc_gdrive_oauth_event');
        } catch {}
      }, 3000);
    } catch {}

    return;
  }

  // 成功获取 code
  status.value = 'success';
  const successPayload = {
    type: 'TGTC_GDRIVE_OAUTH_RESULT',
    status: 'success',
    code: code.trim(),
    state: state?.trim() || undefined,
  };

  // 1. postMessage
  if (window.opener && !window.opener.closed) {
    try {
      window.opener.postMessage(successPayload, window.location.origin);
    } catch (e) {
      console.warn('[GDriveOAuth] postMessage failed:', e);
    }
  }

  // 2. BroadcastChannel
  try {
    const bc = new BroadcastChannel('tgtc_gdrive_oauth_channel');
    bc.postMessage(successPayload);
    bc.close();
  } catch {}

  // 3. localStorage
  try {
    localStorage.setItem('tgtc_gdrive_oauth_event', JSON.stringify({
      ...successPayload,
      timestamp: Date.now(),
    }));
    setTimeout(() => {
      try {
        localStorage.removeItem('tgtc_gdrive_oauth_event');
      } catch {}
    }, 3000);
  } catch {}

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
  padding: 24px;
  background-color: var(--td-bg-color-page, #f3f5f8);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}

.oauth-card {
  width: 100%;
  max-width: 440px;
  background: var(--td-bg-color-container, #ffffff);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  border: 1px solid var(--td-border-level-1-color, #e7e7e7);
  padding: 36px 28px;
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
  border: 4px solid var(--td-brand-color-light, #e0ebff);
  border-top-color: var(--td-brand-color, #0052d9);
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
  color: var(--td-text-color-primary, #181818);
}

.subtitle {
  margin: 0 0 20px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--td-text-color-secondary, #666666);
}

.error-box {
  margin-bottom: 20px;
  padding: 10px 14px;
  font-size: 13px;
  color: #d54941;
  background: #feedec;
  border-radius: 6px;
  word-break: break-all;
  text-align: left;
}

.actions {
  display: flex;
  justify-content: center;
  gap: 12px;
}

.btn {
  padding: 8px 18px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  border: 1px solid transparent;
}

.btn-primary {
  background-color: var(--td-brand-color, #0052d9);
  color: #ffffff;
}

.btn-primary:hover {
  background-color: var(--td-brand-color-hover, #266fe8);
}

.btn-secondary {
  background-color: transparent;
  color: var(--td-text-color-primary, #333333);
  border-color: var(--td-border-level-2-color, #dcdcdc);
}

.btn-secondary:hover {
  background-color: var(--td-bg-color-secondarycontainer, #f3f3f3);
}
</style>
