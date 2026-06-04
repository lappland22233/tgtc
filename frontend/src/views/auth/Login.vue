<template>
  <div class="auth-container">
    <div class="auth-card">
      <div class="auth-header">
        <h1>欢迎回来</h1>
        <p>登录到文件分发系统</p>
      </div>
      <t-form ref="formRef" :data="form" :rules="rules" @submit="handleSubmit">
        <t-form-item label="邮箱" name="email">
          <t-input v-model="form.email" placeholder="请输入邮箱" size="large" />
        </t-form-item>
        <t-form-item label="密码" name="password">
          <t-input v-model="form.password" type="password" placeholder="请输入密码" size="large" />
        </t-form-item>
        <t-form-item>
          <t-button type="submit" theme="primary" size="large" block :loading="loading">
            登录
          </t-button>
        </t-form-item>
      </t-form>
      <div style="text-align: center; margin-top: 24px; color: var(--text-secondary);">
        还没有账号？ <router-link to="/register" style="color: var(--primary-color);">立即注册</router-link>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { MessagePlugin } from 'tdesign-vue-next';
import { useAuthStore } from '../../stores/auth';
import { getErrorMessage } from '../../utils/error';
import { isValidRedirect } from '../../router';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();

const form = ref({
  email: '',
  password: '',
});

const rules = {
  email: [{ required: true, message: '请输入邮箱', type: 'error' }],
  password: [{ required: true, message: '请输入密码', type: 'error' }],
};

const loading = ref(false);

const formRef = ref();

async function handleSubmit() {
  const valid = await formRef.value?.validate();
  if (valid !== true) return;
  loading.value = true;
  try {
    await authStore.login(form.value.email, form.value.password);
    MessagePlugin.success('登录成功');
    const redirect = route.query.redirect as string | undefined;
    if (redirect && isValidRedirect(redirect)) {
      router.push(redirect);
    } else {
      router.push('/');
    }
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    loading.value = false;
  }
}
</script>
