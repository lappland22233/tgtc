<template>
  <div class="layout-container">
    <!-- Desktop Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-logo">
        <h2>
          <span class="logo-icon">⬡</span>
          文件分发系统
        </h2>
      </div>

      <nav class="sidebar-nav">
        <div class="nav-section">工作区</div>
        <router-link to="/dashboard" class="nav-item" :class="{ active: $route.path === '/dashboard' }">
          <span class="nav-icon">⊡</span> 仪表盘
        </router-link>
        <router-link to="/files" class="nav-item" :class="{ active: $route.path === '/files' }">
          <span class="nav-icon">⊟</span> 我的文件
        </router-link>
        <router-link to="/settings" class="nav-item" :class="{ active: $route.path === '/settings' }">
          <span class="nav-icon">⚙</span> 个人设置
        </router-link>

        <template v-if="isAdmin">
          <div class="nav-section">管理后台</div>
          <router-link to="/admin/dashboard-customizer" class="nav-item" :class="{ active: $route.path === '/admin/dashboard-customizer' }">
            <span class="nav-icon">◫</span> 仪表盘
          </router-link>
          <router-link to="/admin/users" class="nav-item" :class="{ active: $route.path === '/admin/users' }">
            <span class="nav-icon">👥</span> 用户管理
          </router-link>
          <router-link to="/admin/files" class="nav-item" :class="{ active: $route.path === '/admin/files' }">
            <span class="nav-icon">⊞</span> 文件管理
          </router-link>
          <router-link to="/admin/config" class="nav-item" :class="{ active: $route.path === '/admin/config' }">
            <span class="nav-icon">⚙</span> 系统配置
          </router-link>
          <router-link to="/admin/access-logs" class="nav-item" :class="{ active: $route.path === '/admin/access-logs' }">
            <span class="nav-icon">◷</span> 访问统计
          </router-link>
          <router-link to="/admin/security" class="nav-item" :class="{ active: $route.path === '/admin/security' }">
            <span class="nav-icon">⬡</span> 安全监控
          </router-link>
          <router-link to="/admin/user-activity" class="nav-item" :class="{ active: $route.path === '/admin/user-activity' }">
            <span class="nav-icon">◎</span> 用户活跃
          </router-link>
          <router-link to="/admin/audit-logs" class="nav-item" :class="{ active: $route.path === '/admin/audit-logs' }">
            <span class="nav-icon">◉</span> 操作审计
          </router-link>
          <router-link to="/admin/telemetry" class="nav-item" :class="{ active: $route.path === '/admin/telemetry' }">
            <span class="nav-icon">⬒</span> 遥测监控
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
    <main class="main-content">
      <button class="mobile-menu-btn" @click="drawerVisible = true" aria-label="打开菜单">
        ☰
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
        <div class="sidebar-logo">
          <h2>
            <span class="logo-icon">⬡</span>
            文件分发系统
          </h2>
        </div>
        <nav class="sidebar-nav">
          <div class="nav-section">工作区</div>
          <router-link to="/dashboard" class="nav-item" :class="{ active: $route.path === '/dashboard' }" @click="drawerVisible = false">
            <span class="nav-icon">⊡</span> 仪表盘
          </router-link>
          <router-link to="/files" class="nav-item" :class="{ active: $route.path === '/files' }" @click="drawerVisible = false">
            <span class="nav-icon">⊟</span> 我的文件
          </router-link>
          <router-link to="/settings" class="nav-item" :class="{ active: $route.path === '/settings' }" @click="drawerVisible = false">
            <span class="nav-icon">⚙</span> 个人设置
          </router-link>

          <template v-if="isAdmin">
            <div class="nav-section">管理后台</div>
            <router-link to="/admin/dashboard-customizer" class="nav-item" :class="{ active: $route.path === '/admin/dashboard-customizer' }" @click="drawerVisible = false">
              <span class="nav-icon">◫</span> 仪表盘
            </router-link>
            <router-link to="/admin/users" class="nav-item" :class="{ active: $route.path === '/admin/users' }" @click="drawerVisible = false">
              <span class="nav-icon">👥</span> 用户管理
            </router-link>
            <router-link to="/admin/files" class="nav-item" :class="{ active: $route.path === '/admin/files' }" @click="drawerVisible = false">
              <span class="nav-icon">⊞</span> 文件管理
            </router-link>
            <router-link to="/admin/config" class="nav-item" :class="{ active: $route.path === '/admin/config' }" @click="drawerVisible = false">
              <span class="nav-icon">⚙</span> 系统配置
            </router-link>
            <router-link to="/admin/access-logs" class="nav-item" :class="{ active: $route.path === '/admin/access-logs' }" @click="drawerVisible = false">
              <span class="nav-icon">◷</span> 访问统计
            </router-link>
            <router-link to="/admin/security" class="nav-item" :class="{ active: $route.path === '/admin/security' }" @click="drawerVisible = false">
              <span class="nav-icon">⬡</span> 安全监控
            </router-link>
            <router-link to="/admin/user-activity" class="nav-item" :class="{ active: $route.path === '/admin/user-activity' }" @click="drawerVisible = false">
              <span class="nav-icon">◎</span> 用户活跃
            </router-link>
            <router-link to="/admin/audit-logs" class="nav-item" :class="{ active: $route.path === '/admin/audit-logs' }" @click="drawerVisible = false">
              <span class="nav-icon">◉</span> 操作审计
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
