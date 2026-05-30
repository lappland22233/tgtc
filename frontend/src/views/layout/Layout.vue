<template>
  <div class="layout-container">
    <aside class="sidebar">
      <div class="sidebar-logo">
        <h2>📦 文件分发系统</h2>
      </div>
      <nav class="sidebar-nav">
        <router-link to="/dashboard" class="nav-item" :class="{ active: $route.path === '/dashboard' }">
          <span>📊</span> 仪表盘
        </router-link>
        <router-link to="/files" class="nav-item" :class="{ active: $route.path === '/files' }">
          <span>📁</span> 我的文件
        </router-link>
        <router-link to="/upload" class="nav-item" :class="{ active: $route.path === '/upload' }">
          <span>⬆️</span> 上传文件
        </router-link>
        <router-link to="/settings" class="nav-item" :class="{ active: $route.path === '/settings' }">
          <span>⚙️</span> 个人设置
        </router-link>
        <template v-if="isAdmin">
          <div style="margin: 16px 0; padding: 0 24px; color: var(--text-secondary); font-size: 12px;">
            ─── 管理后台 ───
          </div>
          <router-link to="/admin" class="nav-item" :class="{ active: $route.path === '/admin' }">
            <span>📈</span> 统计概览
          </router-link>
          <router-link to="/admin/users" class="nav-item" :class="{ active: $route.path === '/admin/users' }">
            <span>👥</span> 用户管理
          </router-link>
          <router-link to="/admin/files" class="nav-item" :class="{ active: $route.path === '/admin/files' }">
            <span>🗂️</span> 文件管理
          </router-link>
          <router-link to="/admin/config" class="nav-item" :class="{ active: $route.path === '/admin/config' }">
            <span>🔧</span> 系统配置
          </router-link>
        </template>
      </nav>
      <div style="padding: 16px 24px; border-top: 1px solid var(--border-color);">
        <div style="margin-bottom: 12px; font-size: 14px;">
          <div style="color: var(--text-secondary);">当前用户</div>
          <div style="font-weight: 500;">{{ authStore.user?.email }}</div>
          <div style="font-size: 12px; color: var(--primary-color);">{{ roleText }}</div>
        </div>
        <t-button variant="base" theme="danger" size="small" block @click="handleLogout">
          退出登录
        </t-button>
      </div>
    </aside>
    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../../stores/auth';
import { storeToRefs } from 'pinia';
import type { UserRole } from '../../types/user';

const router = useRouter();
const authStore = useAuthStore();
const { user } = storeToRefs(authStore);

const isAdmin = computed(() => ['admin', 'super_admin'].includes(user.value?.role ?? ''));
const roleText = computed(() => {
  const map: Record<UserRole, string> = {
    super_admin: '超级管理员',
    admin: '管理员',
    user: '普通用户',
  };
  return map[user.value?.role ?? 'user'] || '普通用户';
});

async function handleLogout() {
  await authStore.logout();
  router.push('/login');
}

onMounted(() => {
  authStore.fetchUser();
});
</script>
