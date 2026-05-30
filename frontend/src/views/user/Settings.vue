<template>
  <div>
    <div class="page-header">
      <h1>个人设置</h1>
      <p>管理您的账号信息</p>
    </div>

    <div class="card">
      <h3 style="margin-bottom: 24px;">修改密码</h3>
      <t-form ref="passwordFormRef" :data="passwordForm" :rules="passwordRules" @submit="handlePasswordChange" layout="vertical">
        <t-form-item label="原密码" name="oldPassword">
          <t-input v-model="passwordForm.oldPassword" type="password" placeholder="请输入原密码" />
        </t-form-item>
        <t-form-item label="新密码" name="newPassword">
          <t-input v-model="passwordForm.newPassword" type="password" placeholder="请输入新密码（至少6位）" />
        </t-form-item>
        <t-form-item label="确认新密码" name="confirmPassword">
          <t-input v-model="passwordForm.confirmPassword" type="password" placeholder="请再次输入新密码" />
        </t-form-item>
        <t-form-item>
          <t-button type="submit" theme="primary">保存修改</t-button>
        </t-form-item>
      </t-form>
    </div>

    <div class="card" style="margin-top: 20px;">
      <h3 style="margin-bottom: 24px;">账号信息</h3>
      <t-descriptions :column="2" border>
        <t-descriptions-item label="邮箱">{{ authStore.user?.email }}</t-descriptions-item>
        <t-descriptions-item label="角色">
          <t-tag :theme="roleTheme">{{ roleText }}</t-tag>
        </t-descriptions-item>
        <t-descriptions-item label="邮箱验证">
          {{ authStore.user?.emailVerified ? '已验证' : '未验证' }}
        </t-descriptions-item>
        <t-descriptions-item label="注册时间">
          {{ formatDate(authStore.user?.createdAt ?? '') }}
        </t-descriptions-item>
      </t-descriptions>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { useAuthStore } from '../../stores/auth';
import { api } from '../../stores/auth';
import { getErrorMessage } from '../../utils/error';
import type { UserRole } from '../../types/user';

const authStore = useAuthStore();

const passwordFormRef = ref();

const passwordForm = reactive({
  oldPassword: '',
  newPassword: '',
  confirmPassword: '',
});

const passwordRules = {
  oldPassword: [{ required: true, message: '请输入原密码' }],
  newPassword: [
    { required: true, message: '请输入新密码' },
    { min: 6, message: '密码至少6位' },
  ],
  confirmPassword: [
    { required: true, message: '请确认新密码' },
    {
      validator: (val: string) => val === passwordForm.newPassword,
      message: '两次密码不一致',
    },
  ],
};

const roleText = computed(() => {
  const map: Record<UserRole, string> = { super_admin: '超级管理员', admin: '管理员', user: '普通用户' };
  return map[authStore.user?.role ?? 'user'] || '普通用户';
});

const roleTheme = computed(() => {
  const map: Record<UserRole, string> = { super_admin: 'warning', admin: 'primary', user: 'default' };
  return map[authStore.user?.role ?? 'user'] || 'default';
});

function formatDate(date: string) {
  return date ? new Date(date).toLocaleDateString('zh-CN') : '-';
}

async function handlePasswordChange() {
  const valid = await passwordFormRef.value?.validate();
  if (valid !== true) return;
  if (!authStore.user) {
    MessagePlugin.error('用户信息缺失，请重新登录');
    return;
  }
  try {
    await api.put('/users/me/password', {
      oldPassword: passwordForm.oldPassword,
      newPassword: passwordForm.newPassword,
    });
    MessagePlugin.success('密码修改成功');
    // 清空表单并清除验证状态，避免显示"不能为空"提示
    passwordFormRef.value?.reset();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}
</script>
