import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { clearThumbToken } from '../utils/thumbnail';
import { clearThumbnailCache } from '../utils/thumbnailCache';
import { PAGE_ROLES, hasAnyRole } from '../utils/permissions';

/**
 * 校验 redirect 参数是否安全，防止任意 URL 跳转（Open Redirect）
 *
 * 使用 new URL(path, location.origin) 解析后再校验来源，避免仅靠字符串包含 `\` 拦截
 * 被浏览器归一化（如 `/\evil.com` → `/\/evil.com`、协议相对 URL 等）绕过。
 * 解析结果的 origin 必须与当前页面同源才视为安全。
 */
export function isValidRedirect(path: string): boolean {
  if (!path || !path.startsWith('/')) return false;
  try {
    const url = new URL(path, window.location.origin);
    return url.origin === window.location.origin;
  } catch {
    // 解析失败一律视为不安全
    return false;
  }
}

const routes: RouteRecordRaw[] = [
  // 公开分享页（无需登录，独立于 Layout）
  {
    path: '/s/:token',
    name: 'ShareView',
    component: () => import('../views/share/ShareView.vue'),
    meta: { public: true },
  },
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
        path: 'shares',
        name: 'UserShares',
        component: () => import('../views/user/Shares.vue'),
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
        meta: { superAdmin: true },
      },
      {
        path: 'admin/security',
        name: 'AdminSecurity',
        component: () => import('../views/admin/SecurityMonitor.vue'),
        meta: { superAdmin: true },
      },
      {
        path: 'admin/user-activity',
        name: 'AdminUserActivity',
        component: () => import('../views/admin/UserActivity.vue'),
        meta: { superAdmin: true },
      },
      {
        path: 'admin/dashboard-customizer',
        name: 'AdminDashboardCustomizer',
        component: () => import('../views/admin/DashboardCustomizer.vue'),
        meta: { admin: true },
      },
      {
        path: 'admin/access-logs',
        name: 'AdminAccessLogs',
        component: () => import('../views/admin/AccessLogs.vue'),
        meta: { superAdmin: true },
      },
      {
        path: 'admin/audit-logs',
        name: 'AdminAuditLogs',
        component: () => import('../views/admin/AuditLogs.vue'),
        meta: { superAdmin: true },
      },
      {
        path: 'admin/telemetry',
        name: 'AdminTelemetry',
        component: () => import('../views/admin/TelemetryStats.vue'),
        meta: { superAdmin: true },
      },
    ],
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

/**
 * 导航锁：防止快速连续切换时并发执行 beforeEach，
 * 导致 fetchUser 竞态和多次 redirect。
 * 使用串行队列而非防抖，确保每次导航都被正确处理。
 */
let navLock: Promise<void> = Promise.resolve();

/**
 * fetchUser 独立超时（ms）。
 * /auth/me 若挂起（默认 axios 30s 超时），会阻塞串行导航锁导致全站路由跳转卡死。
 * 这里设置更短的独立超时，超时后按“未认证”兜底继续导航，绝不阻塞。
 */
const FETCH_USER_TIMEOUT = 8000;

/** 为 Promise 包裹独立超时：超时则 reject，避免无限期等待 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`fetchUser 超时（>${ms}ms）`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

router.beforeEach(async (to, _from, next) => {
  // 串行化所有导航守卫：快速切换时排队执行
  const prevLock = navLock;
  let releaseLock: () => void;
  navLock = new Promise<void>((resolve) => { releaseLock = resolve; });

  try {
    await prevLock;

    // 步骤 0：公开路由（分享页 /s/:token）直接放行，不触发 fetchUser
    // 这是匿名访问场景，不应被重定向到登录页
    if (to.meta.public) {
      next();
      return;
    }

    const authStore = useAuthStore();

    // 步骤 1：首次加载时从 cookie 恢复登录状态
    // fetchUser 内部有并发锁，多次快速调用安全。
    // 额外包裹独立超时 + catch 兜底：/auth/me 挂起或失败时按“未认证”继续导航，
    // 避免阻塞串行导航锁导致全站路由跳转死锁。
    if (!authStore.initialized) {
      try {
        await withTimeout(authStore.fetchUser(), FETCH_USER_TIMEOUT);
      } catch (err) {
        console.warn('[Router] fetchUser 失败或超时，按未认证状态继续导航:', err);
      }
    }

    const isAuthenticated = authStore.isAuthenticated;
    const userRole = authStore.user?.role;

    // 步骤 2：需要认证但未登录 → 跳转登录页
    if (to.meta.requiresAuth && !isAuthenticated) {
      const redirect = (to.path !== '/login' && to.path !== '/register') ? to.fullPath : undefined;
      next({ path: '/login', query: redirect ? { redirect: isValidRedirect(redirect) ? redirect : undefined } : undefined });
      return;
    }

    // 步骤 3：已登录用户访问游客页 → 跳转首页
    if (to.meta.guest && isAuthenticated) {
      next('/');
      return;
    }

    // 步骤 4：页面权限校验（与桌面侧栏、移动抽屉共用唯一权限表）
    const requiredRoles = PAGE_ROLES[to.path]
      ?? (to.meta.superAdmin ? PAGE_ROLES['/admin/config'] : undefined)
      ?? (to.meta.admin ? PAGE_ROLES['/admin'] : undefined);
    if (requiredRoles && !hasAnyRole(userRole, requiredRoles)) {
      next('/');
      return;
    }

    next();
  } finally {
    releaseLock!();
  }
});

/**
 * 路由切换时清除缩略图 token 缓存。
 * 基于 authStore 实际状态而非 localStorage hack。
 */
let lastAuthUserId: string | null = null;
// 缓存 authStore 单例（Pinia store 为单例），避免每次路由切换都调用 useAuthStore()
let cachedAuthStore: ReturnType<typeof useAuthStore> | null = null;
router.afterEach(() => {
  if (!cachedAuthStore) cachedAuthStore = useAuthStore();
  const currentUserId = cachedAuthStore.user?.id ?? null;
  if (currentUserId !== lastAuthUserId) {
    clearThumbToken();
    clearThumbnailCache();
    lastAuthUserId = currentUserId;
  }
});

export default router;
