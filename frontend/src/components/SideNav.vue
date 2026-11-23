<template>
  <header class="workspace-appbar">
    <WorkspaceBrand link="/files" />

    <nav class="workspace-tabs" aria-label="工作台">
      <router-link
        v-for="tab in workspaceTabs"
        :key="tab.to"
        :to="tab.to"
        class="workspace-tab"
        exact-active-class="workspace-tab--active"
      >
        <t-icon :name="tab.icon" class="workspace-tab-icon" size="18px" aria-hidden="true" />
        <span>{{ tab.label }}</span>
      </router-link>
    </nav>

    <div class="workspace-app-actions">
      <slot />
      <button
        ref="accountTrigger"
        class="workspace-account-trigger"
        type="button"
        aria-label="账户"
        aria-haspopup="dialog"
        aria-controls="workspace-account"
        :aria-expanded="accountOpen"
        @click="openAccount"
      >
        <span class="workspace-account-avatar" aria-hidden="true">{{ avatarLetter }}</span>
      </button>
    </div>
  </header>

  <dialog
    id="workspace-account"
    ref="accountDialog"
    class="workspace-account"
    aria-labelledby="workspace-account-title"
    @click.self="closeAccount"
    @close="onAccountClose"
  >
    <div class="workspace-account-content">
      <div class="workspace-account-header">
        <h2 id="workspace-account-title">账户</h2>
        <button class="workspace-account-close" type="button" aria-label="关闭账户" @click="closeAccount">
          <t-icon name="close" size="18px" aria-hidden="true" />
        </button>
      </div>
      <div class="workspace-account-profile">
        <span class="workspace-account-avatar" aria-hidden="true">{{ avatarLetter }}</span>
        <div class="workspace-account-identity">
          <p class="workspace-account-email" :title="email">{{ email }}</p>
          <p class="workspace-account-role">{{ roleText }}</p>
        </div>
      </div>
      <router-link to="/settings" class="workspace-account-item" @click="closeAccount">个人设置</router-link>

      <nav v-if="visibleAdminNav.length" class="workspace-admin-nav" aria-labelledby="workspace-admin-heading">
        <h3 id="workspace-admin-heading">管理后台</h3>
        <router-link
          v-for="item in visibleAdminNav"
          :key="item.to"
          :to="item.to"
          class="workspace-account-item"
          @click="closeAccount"
        >
          {{ item.label }}
        </router-link>
      </nav>

      <button class="workspace-account-item workspace-account-logout" type="button" @click="logout">
        退出登录
      </button>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { UserRole } from '../types/user';
import { getAdminNavGroups } from '@/utils/admin-navigation';
import WorkspaceBrand from './WorkspaceBrand.vue';

const props = defineProps<{
  role: UserRole;
  email: string;
  roleText: string;
  avatarLetter: string;
}>();

const emit = defineEmits<{ logout: [] }>();

const route = useRoute();
const accountTrigger = ref<HTMLButtonElement | null>(null);
const accountDialog = ref<HTMLDialogElement | null>(null);
const accountOpen = ref(false);

const workspaceTabs = [
  { to: '/files', label: '文件', icon: 'folder' },
  { to: '/shares', label: '分享', icon: 'share' },
  { to: '/dashboard', label: '概览', icon: 'home' },
];

const visibleAdminNav = computed(() => getAdminNavGroups(props.role).flatMap(({ links }) => links));

function openAccount() {
  const dialog = accountDialog.value;
  if (!dialog || dialog.open) return;
  dialog.showModal();
  accountOpen.value = true;
}

function closeAccount() {
  const dialog = accountDialog.value;
  if (dialog?.open) dialog.close();
}

function onAccountClose() {
  accountOpen.value = false;
  accountTrigger.value?.focus({ preventScroll: true });
}

function logout() {
  closeAccount();
  emit('logout');
}

watch(() => route.path, closeAccount);
</script>

<style>
.workspace-appbar {
  position: sticky;
  z-index: 20;
  top: 0;
  display: flex;
  align-items: center;
  gap: clamp(16px, 2.3vw, 26px);
  min-height: var(--workspace-header-height);
  padding-inline: 20px;
  border-bottom: 1px solid var(--workspace-border);
  background: var(--workspace-surface);
}

.workspace-app-actions,
.workspace-tabs {
  display: flex;
  align-items: center;
  min-width: 0;
}

.workspace-appbar .workspace-brand {
  min-height: 44px;
  max-width: min(28vw, 236px);
}

.workspace-tabs {
  align-self: stretch;
  align-items: stretch;
  gap: 22px;
}

.workspace-tab {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--workspace-muted);
  text-decoration: none;
  white-space: nowrap;
}

.workspace-tab:hover,
.workspace-tab--active {
  color: var(--workspace-accent);
}

.workspace-tab--active {
  box-shadow: inset 0 -2px var(--workspace-accent);
  font-weight: 650;
}

.workspace-tab-icon {
  display: none;
}

.workspace-app-actions {
  flex: 0 0 auto;
  gap: 10px;
  margin-inline-start: auto;
}

.workspace-account-trigger,
.workspace-account-close {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--workspace-text);
  cursor: pointer;
}

.workspace-account-trigger:hover,
.workspace-account-close:hover {
  background: var(--workspace-selected);
}

.workspace-account-avatar {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--workspace-selected);
  color: var(--workspace-accent);
  font-weight: 650;
}

.workspace-account {
  position: fixed;
  inset: var(--workspace-header-height) 20px auto auto;
  width: min(320px, calc(100vw - 40px));
  max-height: calc(100dvh - var(--workspace-header-height) - 20px);
  margin: 0;
  padding: 0;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--workspace-border);
  border-radius: 12px;
  background: var(--workspace-surface);
  color: var(--workspace-text);
  box-shadow: var(--shadow-lg);
}

.workspace-account::backdrop {
  background: color-mix(in srgb, var(--workspace-text) 20%, transparent);
}

.workspace-account-content {
  padding: 12px;
}

.workspace-account-header,
.workspace-account-profile {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-inline: 8px;
}

.workspace-account-header {
  justify-content: space-between;
}

.workspace-account-header h2 {
  font-size: 16px;
}

.workspace-account-profile {
  min-height: 52px;
  margin-bottom: 8px;
}

.workspace-account-identity {
  min-width: 0;
}

.workspace-account-email {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-account-role,
.workspace-admin-nav h3 {
  color: var(--workspace-muted);
  font-size: 12px;
}

.workspace-admin-nav {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--workspace-border);
}

.workspace-admin-nav h3 {
  padding: 4px 8px;
  font-weight: 650;
}

.workspace-account-item {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 44px;
  padding-inline: 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--workspace-text);
  font: inherit;
  text-align: start;
  text-decoration: none;
  cursor: pointer;
}

.workspace-account-item:hover,
.workspace-account-item[aria-current="page"] {
  background: var(--workspace-selected);
  color: var(--workspace-accent);
}

.workspace-account-logout {
  margin-top: 8px;
  color: var(--color-danger);
}

.workspace-account-logout:hover {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.workspace-appbar :is(a, button):focus-visible,
.workspace-account :is(a, button):focus-visible {
  outline: 2px solid var(--workspace-accent);
  outline-offset: 2px;
}

@media (max-width: 768px) {
  .workspace-appbar {
    gap: 8px;
    padding-inline: 12px;
  }

  .workspace-appbar .workspace-brand {
    max-width: 48vw;
  }

  .workspace-app-actions {
    gap: 4px;
  }

  .workspace-tabs {
    position: fixed;
    inset: auto 0 0;
    justify-content: space-evenly;
    min-height: calc(var(--workspace-mobile-nav-height) + env(safe-area-inset-bottom, 0px));
    padding: 0 8px env(safe-area-inset-bottom, 0px);
    gap: 0;
    border-top: 1px solid var(--workspace-border);
    background: var(--workspace-surface);
  }

  .workspace-tab {
    flex: 1;
    flex-direction: column;
    min-height: 44px;
    gap: 3px;
    font-size: 12px;
  }

  .workspace-tab--active {
    box-shadow: inset 0 2px var(--workspace-accent);
  }

  .workspace-tab-icon {
    display: inline-flex;
  }

  .workspace-account {
    inset: auto 0 0;
    width: 100%;
    max-width: none;
    max-height: min(80dvh, 620px);
    border-radius: 16px 16px 0 0;
  }

  .workspace-account-content {
    padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  }
}
</style>
