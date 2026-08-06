<template>
  <div class="layout-container">
    <!-- Skip to main content (accessibility) -->
    <a href="#main-content" class="skip-link">跳转到主内容</a>

    <!-- 桌面端侧边栏（双栏布局左栏） -->
    <aside class="sidebar">
      <SideNav
        :role="authStore.user?.role || 'user'"
        :email="authStore.user?.email || ''"
        :role-text="roleText"
        :avatar-letter="avatarLetter"
        @logout="handleLogout"
      />
    </aside>

    <!-- 主内容区（双栏布局右栏） -->
    <main id="main-content" class="main-content">
      <button class="mobile-menu-btn" @click="drawerVisible = true" aria-label="打开菜单">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="5" x2="17" y2="5"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="3" y1="15" x2="17" y2="15"/></svg>
      </button>
      <AlertBanner />
      <div class="route-view-container">
        <router-view v-slot="{ Component, route }">
          <transition name="slide-up">
            <component :is="Component" :key="route.path" />
          </transition>
        </router-view>
      </div>
    </main>

    <!-- 移动端抽屉导航 -->
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
        <SideNav
          :role="authStore.user?.role || 'user'"
          :email="authStore.user?.email || ''"
          :role-text="roleText"
          :avatar-letter="avatarLetter"
          @navigate="drawerVisible = false"
          @logout="handleLogout"
        />
      </div>
    </t-drawer>

    <!-- 全局后台上传指示器（跨路由常驻，上传由模块级 upload store 驱动） -->
    <UploadProgressIndicator />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../../stores/auth';
import { storeToRefs } from 'pinia';
import type { UserRole } from '../../types/user';
import AlertBanner from '../../components/AlertBanner.vue';
import SideNav from '../../components/SideNav.vue';
import UploadProgressIndicator from '../../components/UploadProgressIndicator.vue';

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
  try {
    await authStore.logout();
  } catch {
    // 登出接口失败也应继续跳转，避免用户卡在失效会话
  } finally {
    router.push('/login');
  }
}

onMounted(() => {
  if (!authStore.initialized) {
    authStore.fetchUser();
  }

  // Admin 路由首次预载（用户路由已由 useRoutePrefetch composable 处理）
  if (isAdmin.value) {
    const idleCb = window.requestIdleCallback || ((cb: () => void) => setTimeout(cb, 500));
    idleCb(() => {
      import('../admin/Dashboard.vue').catch(() => {});
      import('../admin/Users.vue').catch(() => {});
      import('../admin/Files.vue').catch(() => {});
    });
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

/* 抽屉导航项 — 移动端更大的触控目标 */
.drawer-content :deep(.nav-item) {
  min-height: 48px;
  padding: 14px 16px;
  font-size: 15px;
}

.drawer-content :deep(.nav-section) {
  font-size: 11px;
  padding-top: 20px;
}
</style>
