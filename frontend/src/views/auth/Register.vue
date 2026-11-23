<template>
  <AuthGate :title="authStatus.registrationEnabled ? '创建账号' : '注册功能已关闭'">
    <div v-if="!authStatus.registrationEnabled" class="registration-closed">
      <p>请联系管理员开启注册功能</p>
      <t-button class="gate-submit" theme="primary" @click="router.push('/login')">
        返回登录
      </t-button>
    </div>

    <t-form v-else :aria-busy="loading" ref="formRef" :data="form" :rules="rules" @submit="handleSubmit" label-align="top">
      <t-form-item label="邮箱" name="email">
        <t-input
          v-model="form.email"
          placeholder="请输入邮箱地址"
          size="large"
          type="email"
          autocomplete="email"
          name="email"
          :spellcheck="false"
        />
      </t-form-item>
      <t-form-item label="密码" name="password">
        <t-input
          v-model="form.password"
          type="password"
          placeholder="至少 6 位"
          size="large"
          autocomplete="new-password"
          name="new-password"
        />
      </t-form-item>
      <t-form-item label="确认密码" name="confirmPassword">
        <t-input
          v-model="form.confirmPassword"
          type="password"
          placeholder="请再次输入密码"
          size="large"
          autocomplete="new-password"
          name="confirm-password"
        />
      </t-form-item>
      <div v-if="turnstileEnabled" class="turnstile-section">
        <div ref="turnstileRef" class="turnstile-widget" />
        <p v-if="turnstileStatus" class="turnstile-status" role="status">{{ turnstileStatus }}</p>
      </div>
      <t-form-item v-if="authStatus.emailVerificationEnabled" label="验证码" name="code">
        <div class="code-row">
          <t-input
            v-model="form.code"
            placeholder="6 位验证码"
            size="large"
            class="code-input"
            autocomplete="off"
            name="verification-code"
            :spellcheck="false"
          />
          <t-button
            type="button"
            :disabled="countdown > 0"
            @click="sendCode"
            variant="outline"
            theme="primary"
            size="large"
          >
            {{ countdown > 0 ? `${countdown}s` : '发送验证码' }}
          </t-button>
        </div>
      </t-form-item>
      <t-form-item>
        <t-button class="gate-submit" type="submit" theme="primary" size="large" block :loading="loading">
          {{ loading ? '注册中…' : '注册' }}
        </t-button>
      </t-form-item>
    </t-form>
    <template v-if="authStatus.registrationEnabled" #footer>
      已有账号？
      <router-link to="/login">立即登录</router-link>
    </template>
  </AuthGate>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import MessagePlugin from '@/utils/message';
import { useAuthStore } from '../../stores/auth';
import { api } from '../../stores/auth';
import { getErrorMessage } from '../../utils/error';
import type { AuthStatus } from '../../types/config';
import AuthGate from './AuthGate.vue';

type TurnstileWidgetId = string;
type TurnstileApi = {
  ready?: (callback: () => void) => void;
  render: (container: HTMLElement, options: {
    sitekey: string;
    action: string;
    callback: (token: string) => void;
    'expired-callback': () => void;
    'error-callback': () => void;
  }) => TurnstileWidgetId;
  reset: (widgetId?: TurnstileWidgetId) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const router = useRouter();
const authStore = useAuthStore();

const formRef = ref();

const form = reactive({
  email: '',
  password: '',
  confirmPassword: '',
  code: '',
});

const countdown = ref(0);
const loading = ref(false);
const turnstileRef = ref<HTMLElement | null>(null);
const turnstileToken = ref('');
const turnstileStatus = ref('');
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let turnstileWidgetId: TurnstileWidgetId | null = null;
let turnstileScript: HTMLScriptElement | null = null;
let turnstileScriptPromise: Promise<void> | null = null;
const authStatus = ref<AuthStatus>({
  registrationEnabled: true,
  emailVerificationEnabled: false,
  turnstileEnabled: false,
  siteKey: '',
});
const turnstileEnabled = computed(() => authStatus.value.turnstileEnabled && !!authStatus.value.siteKey);

const rules = computed(() => ({
  email: [
    { required: true, message: '请输入邮箱', type: 'error' },
    { email: true, message: '请输入有效的邮箱地址', type: 'error' },
  ],
  password: [
    { required: true, message: '请输入密码', type: 'error' },
    { min: 6, message: '密码至少6位', type: 'error' },
  ],
  confirmPassword: [
    { required: true, message: '请确认密码', type: 'error' },
    {
      validator: (val: string) => val === form.password,
      message: '两次密码不一致',
      type: 'error',
    },
  ],
  ...(authStatus.value.emailVerificationEnabled ? {
    code: [
      { required: true, message: '请输入验证码', type: 'error' },
      { len: 6, message: '验证码必须是6位', type: 'error' },
    ],
  } : {}),
}));

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>('script[data-turnstile-sdk]');
    const script = existingScript || document.createElement('script');
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      turnstileScriptPromise = null;
      turnstileScript = null;
      if (!existingScript) script.remove();
      reject(new Error('Turnstile 脚本加载失败'));
    };
    const ready = () => {
      if (settled) return;
      if (!window.turnstile) {
        fail();
        return;
      }
      settled = true;
      resolve();
    };
    // load 事件已经保证 api.js 执行完成，不再调用 turnstile.ready()；
    // Cloudflare 会对异步脚本调用 ready() 抛出 TurnstileError。
    script.addEventListener('load', ready, { once: true });
    script.addEventListener('error', fail, { once: true });
    if (!existingScript) {
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.dataset.turnstileSdk = 'true';
      document.head.appendChild(script);
    } else if (window.turnstile) {
      ready();
    }
    turnstileScript = script;
  });
  return turnstileScriptPromise;
}

async function renderTurnstile() {
  if (!turnstileEnabled.value || !turnstileRef.value || turnstileWidgetId !== null) return;
  try {
    await loadTurnstileScript();
    if (!turnstileRef.value || !window.turnstile) return;
    turnstileWidgetId = window.turnstile.render(turnstileRef.value, {
      sitekey: authStatus.value.siteKey,
      action: 'register',
      callback: (token) => {
        turnstileToken.value = token;
        turnstileStatus.value = '';
      },
      'expired-callback': () => {
        turnstileToken.value = '';
        turnstileStatus.value = '验证已过期，请重新完成验证';
      },
      'error-callback': () => {
        turnstileToken.value = '';
        turnstileStatus.value = '验证失败，请重试';
      },
    });
  } catch {
    turnstileToken.value = '';
    turnstileStatus.value = '验证组件加载失败，请刷新页面重试';
  }
}

function resetTurnstile() {
  turnstileToken.value = '';
  if (turnstileWidgetId && window.turnstile) {
    window.turnstile.reset(turnstileWidgetId);
  }
}

async function fetchAuthStatus() {
  try {
    const res = await api.get('/auth/status');
    authStatus.value = { ...authStatus.value, ...res.data.data };
    await nextTick();
    await renderTurnstile();
  } catch {
    MessagePlugin.warning('无法获取注册状态，请稍后重试');
  }
}

async function sendCode() {
  if (!form.email) {
    MessagePlugin.warning('请先输入邮箱');
    return;
  }
  // 发送前前端预检邮箱格式，避免无效邮箱直达后端
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(form.email)) {
    MessagePlugin.warning('请输入有效的邮箱地址');
    return;
  }
  if (turnstileEnabled.value && !turnstileToken.value) {
    turnstileStatus.value = '请先完成安全验证';
    MessagePlugin.warning(turnstileStatus.value);
    return;
  }
  try {
    await authStore.sendCode(form.email, 'register', turnstileToken.value || undefined);
    MessagePlugin.success('验证码已发送');
    countdown.value = 60;
    // 新建 timer 前先清除旧 timer，防止叠加泄漏；
    // 不再使用 onScopeDispose（在事件处理函数中调用无效），统一由 onUnmounted 清理
    if (countdownTimer) {
      clearInterval(countdownTimer);
    }
    const timer = setInterval(() => {
      countdown.value--;
      if (countdown.value <= 0) {
        clearInterval(timer);
        countdownTimer = null;
      }
    }, 1000);
    countdownTimer = timer;
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    resetTurnstile();
  }
}

async function handleSubmit() {
  const valid = await formRef.value?.validate();
  if (valid !== true) return;
  loading.value = true;
  try {
    const code = authStatus.value.emailVerificationEnabled ? form.code : '';
    const res = await authStore.register(form.email, form.password, code);
    const data = res.data;
    if (data?.needVerification) {
      MessagePlugin.success('注册成功，请前往邮箱查收验证码并完成验证');
      router.push('/login');
    } else {
      MessagePlugin.success('注册成功');
      router.push('/');
    }
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  fetchAuthStatus();
});

onUnmounted(() => {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (turnstileWidgetId && window.turnstile) {
    try { window.turnstile.reset(turnstileWidgetId); } catch { /* 组件卸载时 SDK 可能已失效 */ }
  }
  turnstileWidgetId = null;
  turnstileToken.value = '';
  turnstileScript?.remove();
  turnstileScript = null;
  turnstileScriptPromise = null;
});
</script>

<style scoped>
.turnstile-section {
  margin-bottom: 17px;
  overflow-x: auto;
}

.turnstile-widget {
  min-height: 65px;
}

.turnstile-status,
.registration-closed p {
  margin: 0;
  color: var(--workspace-muted);
}

.turnstile-status {
  margin-top: 4px;
  font-size: 13px;
}

.code-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.code-input {
  flex: 1 1 116px;
  min-width: 0;
}

.code-row .t-button {
  min-height: 44px;
  flex: none;
  white-space: nowrap;
}

.registration-closed .gate-submit {
  margin-top: 20px;
}

@media (max-width: 357px) {
  .turnstile-widget {
    zoom: 0.86;
  }
}
</style>
