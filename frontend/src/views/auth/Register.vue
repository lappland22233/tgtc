<template>
  <div class="auth-container">
    <div class="auth-card">
      <div class="auth-header">
        <h1>创建账号</h1>
        <p>注册文件分发系统账号</p>
      </div>

      <!-- 注册已关闭提示 -->
      <div v-if="!authStatus.registrationEnabled" class="reg-closed">
        <div class="reg-closed-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>
        </div>
        <h3>注册功能已关闭</h3>
        <p>请联系管理员开启注册功能</p>
        <t-button theme="primary" class="reg-closed-btn" @click="router.push('/login')">
          返回登录
        </t-button>
      </div>

      <t-form v-else ref="formRef" :data="form" :rules="rules" @submit="handleSubmit" label-align="top">
        <t-form-item label="邮箱" name="email">
          <t-input
            v-model="form.email"
            placeholder="请输入邮箱地址..."
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
            placeholder="请输入密码（至少 6 位）..."
            size="large"
            autocomplete="new-password"
            name="new-password"
          />
        </t-form-item>
        <t-form-item label="确认密码" name="confirmPassword">
          <t-input
            v-model="form.confirmPassword"
            type="password"
            placeholder="请再次输入密码..."
            size="large"
            autocomplete="new-password"
            name="confirm-password"
          />
        </t-form-item>
        <t-form-item v-if="authStatus.emailVerificationEnabled" label="验证码" name="code">
          <div class="code-row">
            <t-input
              v-model="form.code"
              placeholder="请输入 6 位验证码..."
              size="large"
              class="code-input"
              autocomplete="off"
              name="verification-code"
              :spellcheck="false"
            />
            <t-button
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
          <t-button type="submit" theme="primary" size="large" block :loading="loading">
            {{ loading ? '注册中…' : '注册' }}
          </t-button>
        </t-form-item>
      </t-form>
      <div v-if="authStatus.registrationEnabled" class="auth-footer">
        已有账号？
        <router-link to="/login" class="auth-link">立即登录</router-link>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import MessagePlugin from '@/utils/message';
import { useAuthStore } from '../../stores/auth';
import { api } from '../../stores/auth';
import { getErrorMessage } from '../../utils/error';

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
let countdownTimer: ReturnType<typeof setInterval> | null = null;
const authStatus = ref({
  registrationEnabled: true,
  emailVerificationEnabled: false,
  hasSuperAdmin: false,
});

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

async function fetchAuthStatus() {
  try {
    const res = await api.get('/auth/status');
    authStatus.value = res.data.data;
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
  try {
    await authStore.sendCode(form.email, 'register');
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
  }
}

async function handleSubmit() {
  const valid = await formRef.value?.validate();
  if (valid !== true) return;
  loading.value = true;
  try {
    const code = authStatus.value.emailVerificationEnabled ? form.code : '';
    const data = await authStore.register(form.email, form.password, code);
    if (data.needVerification) {
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
});
</script>

<style scoped>
/* .auth-footer / .auth-link 已提取为全局共享类，见 assets/styles.css */

.code-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.code-row .code-input {
  flex: 1;
  min-width: 120px;
}
.code-row .t-button {
  flex-shrink: 0;
  white-space: nowrap;
}

.reg-closed {
  text-align: center;
  padding: 40px 0;
}

.reg-closed-icon {
  display: inline-flex;
  color: var(--text-tertiary);
  margin-bottom: 16px;
}

.reg-closed h3 {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 8px;
}

.reg-closed p {
  color: var(--text-secondary);
  font-size: 14px;
}

.reg-closed-btn {
  margin-top: 16px;
}
</style>
