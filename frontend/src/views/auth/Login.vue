<template>
  <AuthGate title="登录">
    <t-form :aria-busy="loading" ref="formRef" :data="form" :rules="rules" @submit="handleSubmit" label-align="top">
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
          placeholder="请输入密码"
          size="large"
          autocomplete="current-password"
          name="password"
        />
      </t-form-item>
      <t-form-item>
        <t-button class="gate-submit" type="submit" theme="primary" size="large" block :loading="loading">
          {{ loading ? '登录中…' : '登录' }}
        </t-button>
      </t-form-item>
    </t-form>
    <template #footer>
      还没有账号？
      <router-link to="/register">立即注册</router-link>
    </template>
  </AuthGate>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import MessagePlugin from '@/utils/message';
import { useAuthStore } from '../../stores/auth';
import { getErrorMessage } from '../../utils/error';
import { isValidRedirect } from '../../router';
import AuthGate from './AuthGate.vue';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();

const form = ref({
  email: '',
  password: '',
});

const rules = {
  email: [
    { required: true, message: '请输入邮箱', type: 'error' },
    { email: true, message: '请输入有效的邮箱地址', type: 'error' },
  ],
  password: [{ required: true, message: '请输入密码', type: 'error' }],
};

const loading = ref(false);
const formRef = ref();

async function handleSubmit() {
  if (!formRef.value) return;
  const valid = await formRef.value.validate();
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
