<template>
  <div class="auth-container">
    <div class="auth-card">
      <div class="auth-header">
        <h1>创建账号</h1>
        <p>注册文件分发系统账号</p>
      </div>
      
      <!-- 注册已关闭提示 -->
      <div v-if="!authStatus.registrationEnabled" class="card" style="text-align: center; padding: 40px;">
        <div style="font-size: 48px; margin-bottom: 16px;">🔒</div>
        <h3>注册功能已关闭</h3>
        <p style="color: var(--text-secondary); margin-top: 8px;">
          请联系管理员开启注册功能
        </p>
        <t-button theme="primary" style="margin-top: 16px;" @click="router.push('/login')">
          返回登录
        </t-button>
      </div>

      <t-form v-else ref="formRef" :data="form" :rules="rules" @submit="handleSubmit">
        <t-form-item label="邮箱" name="email">
          <t-input v-model="form.email" placeholder="请输入邮箱" size="large" />
        </t-form-item>
        <t-form-item label="密码" name="password">
          <t-input v-model="form.password" type="password" placeholder="请输入密码（至少6位）" size="large" />
        </t-form-item>
        <t-form-item label="确认密码" name="confirmPassword">
          <t-input v-model="form.confirmPassword" type="password" placeholder="请再次输入密码" size="large" />
        </t-form-item>
        <t-form-item v-if="authStatus.emailVerificationEnabled" label="验证码" name="code">
          <div style="display: flex; gap: 12px;">
            <t-input v-model="form.code" placeholder="请输入验证码" size="large" style="flex: 1;" />
            <t-button
              :disabled="countdown > 0"
              @click="sendCode"
              variant="outline"
              theme="primary"
            >
              {{ countdown > 0 ? `${countdown}s` : '发送验证码' }}
            </t-button>
          </div>
        </t-form-item>
        <t-form-item>
          <t-button type="submit" theme="primary" size="large" block :loading="loading">
            注册
          </t-button>
        </t-form-item>
      </t-form>
      <div v-if="authStatus.registrationEnabled" style="text-align: center; margin-top: 24px; color: var(--text-secondary);">
        已有账号？ <router-link to="/login" style="color: var(--primary-color);">立即登录</router-link>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, onScopeDispose, computed } from 'vue';
import { useRouter } from 'vue-router';
import { MessagePlugin } from 'tdesign-vue-next';
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

// 动态生成验证规则
const rules = computed(() => ({
  email: [{ required: true, message: '请输入邮箱', type: 'error' }],
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
  } catch (error: unknown) {
    console.error('获取认证状态失败', error);
    MessagePlugin.warning('无法获取注册状态，请稍后重试');
  }
}

async function sendCode() {
  if (!form.email) {
    MessagePlugin.warning('请先输入邮箱');
    return;
  }
  try {
    await authStore.sendCode(form.email, 'register');
    MessagePlugin.success('验证码已发送');
    countdown.value = 60;
    const timer = setInterval(() => {
      countdown.value--;
      if (countdown.value <= 0) {
        clearInterval(timer);
        countdownTimer = null;
      }
    }, 1000);
    countdownTimer = timer;
    // 组件卸载时自动清理
    onScopeDispose(() => {
      if (timer) clearInterval(timer);
    });
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function handleSubmit() {
  const valid = await formRef.value?.validate();
  if (valid !== true) return;
  loading.value = true;
  try {
    // 如果验证码未开启，传空字符串
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
});
</script>
