<template>
  <div class="layout-container">
    <!-- Skip to main content (accessibility) -->
    <a href="#main-content" class="skip-link">跳转到主内容</a>

    <!-- Desktop Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-logo">
        <h2>
          <span class="logo-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2L17 6v8l-7 4-7-4V6l7-4z"/><path d="M10 10l7-4M10 10v8M10 10L3 6"/></svg></span>
          文件分发系统
        </h2>
      </div>

      <nav class="sidebar-nav">
        <div class="nav-section">工作区</div>
        <router-link to="/dashboard" class="nav-item" :class="{ active: $route.path === '/dashboard' }">
          <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="7" height="7" rx="1.5"/><rect x="11" y="2" width="7" height="7" rx="1.5"/><rect x="2" y="11" width="7" height="7" rx="1.5"/><rect x="11" y="11" width="7" height="7" rx="1.5"/></svg></span> 仪表盘
        </router-link>
        <router-link to="/files" class="nav-item" :class="{ active: $route.path === '/files' }">
          <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5.5A1.5 1.5 0 013.5 4H8l2 2h6.5A1.5 1.5 0 0118 7.5v8a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 012 15.5v-10z"/></svg></span> 我的文件
        </router-link>
        <router-link to="/settings" class="nav-item" :class="{ active: $route.path === '/settings' }">
          <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="3"/><path d="M10 2v2m0 12v2M2 10h2m12 0h2M4.2 4.2l1.4 1.4m8.8 8.8l1.4 1.4M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4"/></svg></span> 个人设置
        </router-link>

        <template v-if="isAdmin">
          <div class="nav-section">管理后台</div>
          <router-link to="/admin/dashboard-customizer" class="nav-item" :class="{ active: $route.path === '/admin/dashboard-customizer' }">
            <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="10" width="4" height="8" rx="1"/><rect x="8" y="6" width="4" height="12" rx="1"/><rect x="14" y="2" width="4" height="16" rx="1"/></svg></span> 仪表盘
          </router-link>
          <router-link to="/admin/users" class="nav-item" :class="{ active: $route.path === '/admin/users' }">
            <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="3"/><path d="M1 18v-1a4 4 0 014-4h4a4 4 0 014 4v1"/><circle cx="15" cy="7" r="2.5"/><path d="M15 13a4 4 0 014 4v1"/></svg></span> 用户管理
          </router-link>
          <router-link to="/admin/files" class="nav-item" :class="{ active: $route.path === '/admin/files' }">
            <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2h7l4 4v10a2 2 0 01-2 2H5a2 2 0 01-2-2V4a2 2 0 012-2z"/><path d="M12 2v4h4"/><line x1="7" y1="10" x2="13" y2="10"/><line x1="7" y1="13" x2="11" y2="13"/></svg></span> 文件管理
          </router-link>
          <router-link to="/admin/config" class="nav-item" :class="{ active: $route.path === '/admin/config' }">
            <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="5" x2="17" y2="5"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="3" y1="15" x2="17" y2="15"/><circle cx="7" cy="5" r="1.5" fill="currentColor"/><circle cx="13" cy="10" r="1.5" fill="currentColor"/><circle cx="9" cy="15" r="1.5" fill="currentColor"/></svg></span> 系统配置
          </router-link>
          <router-link to="/admin/access-logs" class="nav-item" :class="{ active: $route.path === '/admin/access-logs' }">
            <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><polyline points="10 5 10 10 14 12"/></svg></span> 访问统计
          </router-link>
          <router-link to="/admin/security" class="nav-item" :class="{ active: $route.path === '/admin/security' }">
            <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2L3 5.5v4.5c0 4.5 3 8 7 9.5 4-1.5 7-5 7-9.5V5.5L10 2z"/><path d="M7 10l2 2 4-4"/></svg></span> 安全监控
          </router-link>
          <router-link to="/admin/user-activity" class="nav-item" :class="{ active: $route.path === '/admin/user-activity' }">
            <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 10 5 10 7 4 10 16 13 8 15 10 18 10"/></svg></span> 用户活跃
          </router-link>
          <router-link to="/admin/audit-logs" class="nav-item" :class="{ active: $route.path === '/admin/audit-logs' }">
            <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="12" height="16" rx="2"/><line x1="7" y1="7" x2="13" y2="7"/><line x1="7" y1="10" x2="13" y2="10"/><line x1="7" y1="13" x2="10" y2="13"/></svg></span> 操作审计
          </router-link>
          <router-link to="/admin/telemetry" class="nav-item" :class="{ active: $route.path === '/admin/telemetry' }">
            <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="14" rx="2"/><polyline points="7 13 7 9"/><polyline points="10 13 10 7"/><polyline points="13 13 13 5"/></svg></span> 遥测监控
          </router-link>
        </template>
      </nav>

      <div class="sidebar-footer">
        <div class="sidebar-user">
          <div class="sidebar-user-avatar">{{ avatarLetter }}</div>
          <div class="sidebar-user-info">
            <div class="sidebar-user-email" :title="authStore.user?.email">{{ authStore.user?.email }}</div>
            <div class="sidebar-user-role">{{ roleText }}</div>
          </div>
        </div>
        <t-button variant="outline" theme="danger" size="small" block @click="handleLogout">
          退出登录
        </t-button>
      </div>
    </aside>

    <!-- Main Content -->
    <main id="main-content" class="main-content">
      <button class="mobile-menu-btn" @click="drawerVisible = true" aria-label="打开菜单">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="5" x2="17" y2="5"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="3" y1="15" x2="17" y2="15"/></svg>
      </button>
      <AlertBanner />
      <router-view v-slot="{ Component }">
        <transition name="slide-up" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>

    <!-- Mobile Drawer -->
    <t-drawer
      v-model:visible="drawerVisible"
      placement="left"
      :size="260"
      :header="false"
      :footer="false"
      :close-btn="true"
      destroy-on-close
    >
      <div class="drawer-content">
        <a href="#main-content" class="skip-link" @click="drawerVisible = false">跳转到主内容</a>
        <div class="sidebar-logo">
          <h2>
            <span class="logo-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2L17 6v8l-7 4-7-4V6l7-4z"/><path d="M10 10l7-4M10 10v8M10 10L3 6"/></svg></span>
            文件分发系统
          </h2>
        </div>
        <nav class="sidebar-nav">
          <div class="nav-section">工作区</div>
          <router-link to="/dashboard" class="nav-item" :class="{ active: $route.path === '/dashboard' }" @click="drawerVisible = false">
            <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="7" height="7" rx="1.5"/><rect x="11" y="2" width="7" height="7" rx="1.5"/><rect x="2" y="11" width="7" height="7" rx="1.5"/><rect x="11" y="11" width="7" height="7" rx="1.5"/></svg></span> 仪表盘
          </router-link>
          <router-link to="/files" class="nav-item" :class="{ active: $route.path === '/files' }" @click="drawerVisible = false">
            <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5.5A1.5 1.5 0 013.5 4H8l2 2h6.5A1.5 1.5 0 0118 7.5v8a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 012 15.5v-10z"/></svg></span> 我的文件
          </router-link>
          <router-link to="/settings" class="nav-item" :class="{ active: $route.path === '/settings' }" @click="drawerVisible = false">
            <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="3"/><path d="M10 2v2m0 12v2M2 10h2m12 0h2M4.2 4.2l1.4 1.4m8.8 8.8l1.4 1.4M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4"/></svg></span> 个人设置
          </router-link>

          <template v-if="isAdmin">
            <div class="nav-section">管理后台</div>
            <router-link to="/admin/dashboard-customizer" class="nav-item" :class="{ active: $route.path === '/admin/dashboard-customizer' }" @click="drawerVisible = false">
              <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="10" width="4" height="8" rx="1"/><rect x="8" y="6" width="4" height="12" rx="1"/><rect x="14" y="2" width="4" height="16" rx="1"/></svg></span> 仪表盘
            </router-link>
            <router-link to="/admin/users" class="nav-item" :class="{ active: $route.path === '/admin/users' }" @click="drawerVisible = false">
              <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="3"/><path d="M1 18v-1a4 4 0 014-4h4a4 4 0 014 4v1"/><circle cx="15" cy="7" r="2.5"/><path d="M15 13a4 4 0 014 4v1"/></svg></span> 用户管理
            </router-link>
            <router-link to="/admin/files" class="nav-item" :class="{ active: $route.path === '/admin/files' }" @click="drawerVisible = false">
              <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2h7l4 4v10a2 2 0 01-2 2H5a2 2 0 01-2-2V4a2 2 0 012-2z"/><path d="M12 2v4h4"/><line x1="7" y1="10" x2="13" y2="10"/><line x1="7" y1="13" x2="11" y2="13"/></svg></span> 文件管理
            </router-link>
            <router-link to="/admin/config" class="nav-item" :class="{ active: $route.path === '/admin/config' }" @click="drawerVisible = false">
              <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="5" x2="17" y2="5"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="3" y1="15" x2="17" y2="15"/><circle cx="7" cy="5" r="1.5" fill="currentColor"/><circle cx="13" cy="10" r="1.5" fill="currentColor"/><circle cx="9" cy="15" r="1.5" fill="currentColor"/></svg></span> 系统配置
            </router-link>
            <router-link to="/admin/access-logs" class="nav-item" :class="{ active: $route.path === '/admin/access-logs' }" @click="drawerVisible = false">
              <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><polyline points="10 5 10 10 14 12"/></svg></span> 访问统计
            </router-link>
            <router-link to="/admin/security" class="nav-item" :class="{ active: $route.path === '/admin/security' }" @click="drawerVisible = false">
              <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2L3 5.5v4.5c0 4.5 3 8 7 9.5 4-1.5 7-5 7-9.5V5.5L10 2z"/><path d="M7 10l2 2 4-4"/></svg></span> 安全监控
            </router-link>
            <router-link to="/admin/user-activity" class="nav-item" :class="{ active: $route.path === '/admin/user-activity' }" @click="drawerVisible = false">
              <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 10 5 10 7 4 10 16 13 8 15 10 18 10"/></svg></span> 用户活跃
            </router-link>
            <router-link to="/admin/audit-logs" class="nav-item" :class="{ active: $route.path === '/admin/audit-logs' }" @click="drawerVisible = false">
              <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="12" height="16" rx="2"/><line x1="7" y1="7" x2="13" y2="7"/><line x1="7" y1="10" x2="13" y2="10"/><line x1="7" y1="13" x2="10" y2="13"/></svg></span> 操作审计
            </router-link>
            <router-link to="/admin/telemetry" class="nav-item" :class="{ active: $route.path === '/admin/telemetry' }" @click="drawerVisible = false">
              <span class="nav-icon"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="14" rx="2"/><polyline points="7 13 7 9"/><polyline points="10 13 10 7"/><polyline points="13 13 13 5"/></svg></span> 遥测监控
            </router-link>
          </template>
        </nav>
        <div class="sidebar-footer">
          <div class="sidebar-user">
            <div class="sidebar-user-avatar">{{ avatarLetter }}</div>
            <div class="sidebar-user-info">
              <div class="sidebar-user-email" :title="authStore.user?.email">{{ authStore.user?.email }}</div>
              <div class="sidebar-user-role">{{ roleText }}</div>
            </div>
          </div>
          <t-button variant="outline" theme="danger" size="small" block @click="handleLogout">
            退出登录
          </t-button>
        </div>
      </div>
    </t-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../../stores/auth';
import { storeToRefs } from 'pinia';
import type { UserRole } from '../../types/user';
import AlertBanner from '../../components/AlertBanner.vue';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();
const { user } = storeToRefs(authStore);

const drawerVisible = ref(false);

watch(() => route.path, () => {
  if (drawerVisible.value) {
    drawerVisible.value = false;
  }
});

const isAdmin = computed(() => ['admin', 'super_admin'].includes(user.value?.role ?? ''));

const roleText = computed(() => {
  const map: Record<UserRole, string> = {
    super_admin: '超级管理员',
    admin: '管理员',
    user: '普通用户',
  };
  return map[user.value?.role ?? 'user'] || '普通用户';
});

const avatarLetter = computed(() => {
  const email = user.value?.email || 'U';
  return email.charAt(0).toUpperCase();
});

async function handleLogout() {
  await authStore.logout();
  router.push('/login');
}

onMounted(() => {
  if (!authStore.initialized) {
    authStore.fetchUser();
  }
});
</script>

<style scoped>
.drawer-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--color-bg-elevated);
}

/* Drawer nav items — larger touch targets for mobile */
.drawer-content .nav-item {
  min-height: 48px;
  padding: 14px 16px;
  font-size: 15px;
}

.drawer-content .nav-section {
  font-size: 11px;
  padding-top: 20px;
}
</style>
