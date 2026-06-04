import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { clearThumbToken } from '../utils/thumbnail';

/**
 * 校验 redirect 参数是否安全，防止任意 URL 跳转（Open Redirect）
 */
export function isValidRedirect(path: string): boolean {
  return !!path && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\');
}

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/auth/Login.vue'),
    meta: { guest: true },
  },
  {
    path: '/register',
    name: 'Register',
    component: () => import('../views/auth/Register.vue'),
    meta: { guest: true },
  },
  {
    path: '/',
    component: () => import('../views/layout/Layout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        redirect: '/dashboard',
      },
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('../views/user/Dashboard.vue'),
      },
      {
        path: 'files',
        name: 'UserFiles',
        component: () => import('../views/user/FileList.vue'),
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('../views/user/Settings.vue'),
      },
      // Admin routes
      {
        path: 'admin',
        name: 'AdminDashboard',
        component: () => import('../views/admin/Dashboard.vue'),
        meta: { admin: true },
      },
      {
        path: 'admin/users',
        name: 'AdminUsers',
        component: () => import('../views/admin/Users.vue'),
        meta: { admin: true },
      },
      {
        path: 'admin/files',
        name: 'AdminFiles',
        component: () => import('../views/admin/Files.vue'),
        meta: { admin: true },
      },
      {
        path: 'admin/config',
        name: 'AdminConfig',
        component: () => import('../views/admin/Config.vue'),
        meta: { admin: true },
      },
    ],
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to, _from, next) => {
  const authStore = useAuthStore();

  // 步骤 1：首次加载时从 cookie 恢复登录状态（await 确保完成）
  if (!authStore.initialized) {
    await authStore.fetchUser();
  }

  const isAuthenticated = authStore.isAuthenticated;
  const userRole = authStore.user?.role;

  // 步骤 2：需要认证但未登录 → 跳转登录页（携带 redirect 参数）
  if (to.meta.requiresAuth && !isAuthenticated) {
    next({ path: '/login', query: { redirect: to.fullPath } });
    return;
  }

  // 步骤 3：已登录用户访问游客页 → 跳转首页
  if (to.meta.guest && isAuthenticated) {
    next('/');
    return;
  }

  // 步骤 4：需要管理员权限（此时已确认 isAuthenticated 为 true）
  if (to.meta.admin) {
    if (!isAuthenticated) {
      next('/login');
      return;
    }

    const adminRoles = ['admin', 'super_admin'] as const;
    if (!userRole || !adminRoles.includes(userRole as typeof adminRoles[number])) {
      // 跳转首页并显示提示（避免直接 /login 造成循环）
      next('/');
      return;
    }
  }

  next();
});

// 路由切换时清除缩略图 token 缓存
router.afterEach(() => {
  clearThumbToken();
});

export default router;
