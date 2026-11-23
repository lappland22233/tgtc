<template>
  <div class="workspace-layout">
    <a href="#main-content" class="skip-link workspace-skip-link" @click.prevent="mainContent?.focus()">跳转到主内容</a>

    <SideNav
      :role="user?.role || 'user'"
      :email="user?.email || ''"
      :role-text="roleText"
      :avatar-letter="avatarLetter"
      @logout="handleLogout"
    >
      <WorkspaceTransfers />
    </SideNav>

    <main
      id="main-content"
      ref="mainContent"
      class="workspace-main"
      :class="{ 'workspace-main--files': isFiles, 'workspace-main--admin': isAdminView }"
      tabindex="-1"
    >
      <AlertBanner />
      <div :class="{ 'workspace-admin-layout': isAdminView }">
        <WorkspaceAdminNavigation v-if="isAdminView && user" :role="user.role" />
        <div class="route-view-container">
          <router-view v-slot="{ Component, route }">
            <transition name="slide-up">
              <component :is="Component" :key="route.path" />
            </transition>
          </router-view>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, provide, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../../stores/auth';
import { storeToRefs } from 'pinia';
import type { UserRole } from '../../types/user';
import { hasAnyRole, PAGE_ROLES } from '../../utils/permissions';
import AlertBanner from '../../components/AlertBanner.vue';
import SideNav from '../../components/SideNav.vue';
import WorkspaceAdminNavigation from '@/components/WorkspaceAdminNavigation.vue';
import WorkspaceTransfers from '@/components/WorkspaceTransfers.vue';
import { WORKSPACE_TRANSFERS } from '@/composables/workspaceTransfers';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();
const { user } = storeToRefs(authStore);

const mainContent = ref<HTMLElement | null>(null);
const isFiles = computed(() => route.name === 'UserFiles');
const isAdminView = computed(() => route.meta.admin === true || route.meta.superAdmin === true);

provide(WORKSPACE_TRANSFERS, {
  target: ref<HTMLElement | null>(null),
  visible: ref(false),
});

const roleLabels: Record<UserRole, string> = {
  super_admin: '超级管理员',
  admin: '管理员',
  user: '普通用户',
};

const roleText = computed(() => roleLabels[user.value?.role ?? 'user']);
const avatarLetter = computed(() => (user.value?.email || 'U').charAt(0).toUpperCase());

async function handleLogout() {
  try {
    await authStore.logout();
  } catch {
    // 登出接口失败时仍离开工作台，避免停在失效会话。
  } finally {
    router.push('/login');
  }
}

onMounted(() => {
  if (!authStore.initialized) {
    authStore.fetchUser();
  }

  if (hasAnyRole(user.value?.role, PAGE_ROLES['/admin'])) {
    const idleCb = window.requestIdleCallback || ((cb: () => void) => setTimeout(cb, 500));
    idleCb(() => {
      import('../admin/Dashboard.vue').catch(() => {});
      import('../admin/Users.vue').catch(() => {});
      import('../admin/Files.vue').catch(() => {});
    });
  }
});
</script>

<style src="../admin/admin-content.css"></style>

<style scoped>
.workspace-layout {
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--workspace-canvas);
  color: var(--workspace-text);
}

.workspace-main {
  min-width: 0;
  padding: clamp(16px, 3vw, 32px);
  scroll-margin-top: var(--workspace-header-height);
}

.workspace-main--files,
.workspace-main--admin {
  padding: 0;
}

.workspace-admin-layout > .route-view-container {
  min-width: 0;
  min-height: calc(100dvh - var(--workspace-header-height));
  padding: clamp(16px, 2.5vw, 30px);
  background: var(--workspace-surface);
}

@media (min-width: 960px) {
  .workspace-admin-layout {
    display: grid;
    grid-template-columns: clamp(152px, 16vw, 206px) minmax(0, 1fr);
  }

  .workspace-admin-layout > .route-view-container { border-inline-start: 1px solid var(--workspace-border); }
}

.workspace-skip-link {
  position: fixed;
  background: var(--workspace-accent);
  color: var(--workspace-on-accent);
}

@media (max-width: 768px) {
  .workspace-layout {
    padding-bottom: calc(var(--workspace-mobile-nav-height) + env(safe-area-inset-bottom, 0px));
  }
}
</style>
