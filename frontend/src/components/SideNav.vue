<template>
  <div class="sidenav">
    <div class="sidebar-logo">
      <h2>
        <span class="logo-icon" v-html="icons.logo"></span>
        文件分发系统
      </h2>
    </div>

    <nav class="sidebar-nav">
      <div class="nav-section">工作区</div>
      <router-link
        v-for="item in workspaceNav"
        :key="item.to"
        :to="item.to"
        class="nav-item"
        :class="{ active: isActive(item.to) }"
        @click="emit('navigate')"
      >
        <span class="nav-icon" v-html="item.icon"></span>
        {{ item.label }}
      </router-link>

      <template v-if="visibleAdminNav.length > 0">
        <div class="nav-section">管理后台</div>
        <router-link
          v-for="item in visibleAdminNav"
          :key="item.to"
          :to="item.to"
          class="nav-item"
          :class="{ active: isActive(item.to) }"
          @click="emit('navigate')"
        >
          <span class="nav-icon" v-html="item.icon"></span>
          {{ item.label }}
        </router-link>
      </template>
    </nav>

    <div class="sidebar-footer">
      <div class="sidebar-user">
        <div class="sidebar-user-avatar">{{ avatarLetter }}</div>
        <div class="sidebar-user-info">
          <div class="sidebar-user-email" :title="email">{{ email }}</div>
          <div class="sidebar-user-role">{{ roleText }}</div>
        </div>
      </div>
      <t-button variant="outline" theme="danger" size="small" block @click="emit('logout')">
        退出登录
      </t-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import type { UserRole } from '../types/user';
import { PAGE_ROLES, hasAnyRole } from '../utils/permissions';

const props = defineProps<{
  role: UserRole;
  email: string;
  roleText: string;
  avatarLetter: string;
}>();

const emit = defineEmits<{
  navigate: [];
  logout: [];
}>();

const route = useRoute();

/**
 * 高亮判断：精确匹配或子路由前缀匹配。
 * 例如 /files 会高亮 /files/:id；普通用户仪表盘不会误高亮管理后台页面。
 */
function isActive(to: string): boolean {
  return route.path === to || route.path.startsWith(to + '/');
}

/** 图标统一为 currentColor 描边 SVG，随 nav-item 状态变色。静态资源，无 XSS 风险。 */
const svg = (inner: string) =>
  `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const icons = {
  logo: svg('<path d="M10 2L17 6v8l-7 4-7-4V6l7-4z"/><path d="M10 10l7-4M10 10v8M10 10L3 6"/>'),
  dashboard: svg('<rect x="2" y="2" width="7" height="7" rx="1.5"/><rect x="11" y="2" width="7" height="7" rx="1.5"/><rect x="2" y="11" width="7" height="7" rx="1.5"/><rect x="11" y="11" width="7" height="7" rx="1.5"/>'),
  files: svg('<path d="M2 5.5A1.5 1.5 0 013.5 4H8l2 2h6.5A1.5 1.5 0 0118 7.5v8a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 012 15.5v-10z"/>'),
  shares: svg('<circle cx="14" cy="5" r="2.5"/><circle cx="5" cy="10" r="2.5"/><circle cx="14" cy="15" r="2.5"/><path d="M7.2 8.8l4.6-2.6M7.2 11.2l4.6 2.6"/>'),
  settings: svg('<circle cx="10" cy="10" r="3"/><path d="M10 2v2m0 12v2M2 10h2m12 0h2M4.2 4.2l1.4 1.4m8.8 8.8l1.4 1.4M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4"/>'),
  users: svg('<circle cx="7" cy="7" r="3"/><path d="M1 18v-1a4 4 0 014-4h4a4 4 0 014 4v1"/><circle cx="15" cy="7" r="2.5"/><path d="M15 13a4 4 0 014 4v1"/>'),
  adminFiles: svg('<path d="M5 2h7l4 4v10a2 2 0 01-2 2H5a2 2 0 01-2-2V4a2 2 0 012-2z"/><path d="M12 2v4h4"/><line x1="7" y1="10" x2="13" y2="10"/><line x1="7" y1="13" x2="11" y2="13"/>'),
  config: svg('<line x1="3" y1="5" x2="17" y2="5"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="3" y1="15" x2="17" y2="15"/><circle cx="7" cy="5" r="1.5" fill="currentColor"/><circle cx="13" cy="10" r="1.5" fill="currentColor"/><circle cx="9" cy="15" r="1.5" fill="currentColor"/>'),
  accessLogs: svg('<circle cx="10" cy="10" r="8"/><polyline points="10 5 10 10 14 12"/>'),
  security: svg('<path d="M10 2L3 5.5v4.5c0 4.5 3 8 7 9.5 4-1.5 7-5 7-9.5V5.5L10 2z"/><path d="M7 10l2 2 4-4"/>'),
  userActivity: svg('<polyline points="2 10 5 10 7 4 10 16 13 8 15 10 18 10"/>'),
  auditLogs: svg('<rect x="4" y="2" width="12" height="16" rx="2"/><line x1="7" y1="7" x2="13" y2="7"/><line x1="7" y1="10" x2="13" y2="10"/><line x1="7" y1="13" x2="10" y2="13"/>'),
};

interface NavItem {
  to: string;
  label: string;
  icon: string;
  roles: readonly UserRole[];
}

const workspaceNav: NavItem[] = [
  { to: '/dashboard', label: '仪表盘', icon: icons.dashboard, roles: PAGE_ROLES['/dashboard'] },
  { to: '/files', label: '我的文件', icon: icons.files, roles: PAGE_ROLES['/files'] },
  { to: '/shares', label: '我的分享', icon: icons.shares, roles: PAGE_ROLES['/shares'] },
  { to: '/settings', label: '个人设置', icon: icons.settings, roles: PAGE_ROLES['/settings'] },
];

const adminNav: NavItem[] = [
  { to: '/admin/users', label: '用户管理', icon: icons.users, roles: PAGE_ROLES['/admin/users'] },
  { to: '/admin/files', label: '文件管理', icon: icons.adminFiles, roles: PAGE_ROLES['/admin/files'] },
  { to: '/admin/access-logs', label: '访问统计', icon: icons.accessLogs, roles: PAGE_ROLES['/admin/access-logs'] },
  { to: '/admin/security', label: '安全监控', icon: icons.security, roles: PAGE_ROLES['/admin/security'] },
  { to: '/admin/user-activity', label: '用户活跃', icon: icons.userActivity, roles: PAGE_ROLES['/admin/user-activity'] },
  { to: '/admin/audit-logs', label: '操作审计', icon: icons.auditLogs, roles: PAGE_ROLES['/admin/audit-logs'] },
  // 系统配置包含仅超级管理员可读取的缓存配置和仅超级管理员可保存的全局配置，
  // 因此按“拥有完整页面权限”原则只向超级管理员展示。
  { to: '/admin/config', label: '系统配置', icon: icons.config, roles: PAGE_ROLES['/admin/config'] },
];

const visibleAdminNav = computed(() => adminNav.filter((item) => hasAnyRole(props.role, item.roles)));
</script>

<style scoped>
.sidenav {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
</style>
