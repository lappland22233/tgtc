// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L6 回归：路由守卫此前无测试。覆盖未登录跳转、公开分享页豁免、
 * 已登录访问游客页、角色不足回首页、串行导航锁以及 redirect 参数安全校验。
 */

// 路由模块间接引入 TDesign 子路径（其样式为裸 .css，Node 侧不可直接加载），
// 与既有 SideNav.spec.ts 一致地打桩，避免污染被测守卫逻辑。
vi.mock('tdesign-vue-next/es/message', () => ({
  MessagePlugin: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('tdesign-vue-next/es/dialog', () => ({
  DialogPlugin: { confirm: vi.fn(), alert: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../views/auth/Login.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../views/user/FileList.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../views/user/Dashboard.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../views/share/ShareView.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../views/layout/Layout.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../views/admin/Config.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../views/admin/Users.vue', () => ({ default: { template: '<div />' } }));

vi.mock('../stores/mediaPlayback', () => ({
  useMediaPlaybackStore: () => ({ session: null, requestStop: vi.fn() }),
}));

const fetchUser = vi.fn(async () => {
  // 真实 store 在 fetchUser 内完成初始化；此处同样置位，避免守卫重复触发会话恢复。
  authStore.initialized = true;
});
const authStore: Record<string, unknown> = {
  user: null,
  initialized: false,
  isSessionStale: () => false,
  fetchUser,
};
Object.defineProperty(authStore, 'isAuthenticated', { get: () => !!authStore.user });
vi.mock('../stores/auth', () => ({ useAuthStore: () => authStore }));

import router, { isValidRedirect } from './index';

const adminUser = { id: 'admin-1', role: 'admin', isBanned: false };
const superAdminUser = { id: 'super-1', role: 'super_admin', isBanned: false };
const normalUser = { id: 'user-1', role: 'user', isBanned: false };

describe('router 守卫', () => {
  beforeEach(async () => {
    authStore.user = null;
    authStore.initialized = false;
    fetchUser.mockClear();
    await router.replace('/login').catch(() => undefined);
    // 重置守卫依赖的 store 状态（replace 已触发一次 fetchUser，这里再清一次计数）
    authStore.user = null;
    authStore.initialized = false;
    fetchUser.mockClear();
  });

  it('未登录访问受保护路由时跳转登录页并携带合法 redirect', async () => {
    authStore.fetchUser = fetchUser;

    await router.push('/files?tag=1').catch(() => undefined);

    expect(router.currentRoute.value.path).toBe('/login');
    expect(router.currentRoute.value.query.redirect).toBe('/files?tag=1');
  });

  it('公开分享页不被重定向，也不触发会话拉取', async () => {
    await router.push('/s/abc123').catch(() => undefined);

    expect(router.currentRoute.value.path).toBe('/s/abc123');
    expect(fetchUser).not.toHaveBeenCalled();
  });

  it('已登录用户访问游客页被送回首页', async () => {
    authStore.user = normalUser;
    authStore.initialized = true;
    // 先离开 /login：vue-router 对重复导航会直接中止，不会触发守卫。
    await router.replace('/dashboard').catch(() => undefined);

    await router.push('/login').catch(() => undefined);

    // '/' 重定向到 /dashboard
    expect(router.currentRoute.value.path).toBe('/dashboard');
  });

  it('角色不足访问 admin 页面时回首页', async () => {
    authStore.user = normalUser;
    authStore.initialized = true;

    await router.push('/admin/config').catch(() => undefined);

    expect(router.currentRoute.value.path).toBe('/dashboard');
  });

  it('普通 admin 不能进入 super_admin 专属页面', async () => {
    authStore.user = adminUser;
    authStore.initialized = true;

    await router.push('/admin/config').catch(() => undefined);

    expect(router.currentRoute.value.path).toBe('/dashboard');
  });

  it('具备角色时可进入 admin 页面', async () => {
    authStore.user = adminUser;
    authStore.initialized = true;

    await router.push('/admin/users').catch(() => undefined);

    expect(router.currentRoute.value.path).toBe('/admin/users');

    authStore.user = superAdminUser;
    await router.push('/admin/config').catch(() => undefined);

    expect(router.currentRoute.value.path).toBe('/admin/config');
  });

  it('封禁用户被强制登出并跳转登录页', async () => {
    authStore.user = { id: 'banned', role: 'user', isBanned: true };
    authStore.initialized = true;

    await router.push('/files').catch(() => undefined);

    expect(router.currentRoute.value.path).toBe('/login');
    expect(authStore.user).toBeNull();
  });

  it('会话恢复只在未初始化时触发一次（串行导航锁）', async () => {
    await Promise.allSettled([
      router.push('/files').catch(() => undefined),
      router.push('/dashboard').catch(() => undefined),
      router.push('/files').catch(() => undefined),
    ]);

    expect(fetchUser).toHaveBeenCalledTimes(1);
  });

  it('非法 redirect（协议相对 / 跨站）被识别为不安全', () => {
    expect(isValidRedirect('/files?tag=1')).toBe(true);
    expect(isValidRedirect('//evil.example/path')).toBe(false);
    expect(isValidRedirect('https://evil.example/')).toBe(false);
    expect(isValidRedirect('')).toBe(false);
  });
});
