import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '../api/client';
import { clearRedirectState } from '../api/client';
import type { User } from '../types/user';
import type { AuthStatus } from '../types/config';

export type SendCodeType = 'register' | 'reset_password';
export type { AuthStatus };

interface AuthResponseData {
  user?: User;
  needVerification?: boolean;
  message?: string;
}

export function getAuthResponseData(response: { data?: { data?: AuthResponseData } }): AuthResponseData {
  const data = response.data?.data;
  return data && typeof data === 'object' ? data : {};
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const initialized = ref(false);

  const isAuthenticated = computed(() => !!user.value);

  // fetchUser 并发锁：防止 router beforeEach 触发重复请求
  let fetchUserPromise: Promise<void> | null = null;

  // ── 会话时效重拉（G10-05）──
  /** /auth/me 最近一次成功拉取的时间戳（ms）；未拉取过为 0 */
  let lastFetchedAt = 0;
  /** 会话 TTL（ms）：超过该时长后，页面回到前台 / 守卫时触发重拉 */
  const SESSION_REFRESH_TTL = 60 * 1000;

  /** 判断当前会话数据是否已过期、需要重拉 */
  function isSessionStale(): boolean {
    if (!initialized.value) return true;
    if (!user.value) return false; // 未登录无需重拉
    return Date.now() - lastFetchedAt > SESSION_REFRESH_TTL;
  }

  /**
   * 会话时效重拉：页面回到前台（visibilitychange）时调用。
   * 仅当已有登录态且超过 TTL 才重拉 /auth/me，避免不必要的请求；
   * 若命中封禁 / 降权（角色变化），由 fetchUser 返回的服务端权威状态直接覆盖。
   */
  function refreshIfStale() {
    if (document.visibilityState !== 'visible') return;
    if (!isSessionStale()) return;
    // 静默刷新：失败不打断用户（保留当前状态），下次可见时再试
    fetchUser().catch((err) => {
      console.warn('[Auth] 会话时效重拉失败（保留当前状态）:', err);
    });
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', refreshIfStale);
  }

  // 跨标签页登出同步 — 惰性初始化（HMR 安全）
  let authChannel: BroadcastChannel | null = null;
  function getAuthChannel(): BroadcastChannel | null {
    if (authChannel) return authChannel;
    if (typeof BroadcastChannel === 'undefined') return null;
    authChannel = new BroadcastChannel('auth-sync');
    authChannel.onmessage = (event) => {
      // 同源校验（纵深防御）：BroadcastChannel 本身为同源通信，这里再次校验 origin，
      // 并严格限定消息内容必须为字符串 'logout'，避免被伪造/误发消息触发登出。
      if (event.origin && event.origin !== window.location.origin) return;
      if (event.data === 'logout') {
        user.value = null;
        initialized.value = true;
      }
    };
    return authChannel;
  }
  // 首次加载时初始化
  getAuthChannel();

  // Vite HMR 安全：热更新时关闭旧 channel
  const viteHot = (import.meta as any).hot;
  if (viteHot) {
    viteHot.dispose(() => { authChannel?.close(); authChannel = null; });
  }

  /**
   * 关闭 BroadcastChannel，应在应用销毁时调用（如路由/App 组件中）
   */
  function closeAuthChannel() {
    authChannel?.close();
    authChannel = null;
  }

  async function login(email: string, password: string) {
    const response = await api.post('/auth/login', { email, password });
    const data = getAuthResponseData(response);
    // 会话只由 HttpOnly Cookie 建立；响应体中的 user 是可选的兼容快照，不依赖 accessToken。
    if (data.user?.id) user.value = data.user;
    clearRedirectState(); // 登录成功后重置重定向状态
    // 通过 /auth/me 验证 Cookie 会话并获取服务端权威用户状态。
    await fetchUser();
    if (!user.value) {
      throw new Error('登录会话建立失败，请重试');
    }
    return response.data;
  }

  async function register(email: string, password: string, code: string) {
    const response = await api.post('/auth/register', { email, password, code });
    const data = getAuthResponseData(response);
    if (data.needVerification) {
      return response;
    }
    // 注册成功后的自动登录同样以 Cookie + /auth/me 为准，响应无需包含 accessToken。
    if (data.user?.id) user.value = data.user;
    await fetchUser();
    if (!user.value) {
      throw new Error('注册成功，但登录会话建立失败，请重新登录');
    }
    return response;
  }

  async function sendCode(email: string, type: SendCodeType, turnstileToken?: string) {
    return api.post('/auth/send-code', {
      email,
      type,
      ...(turnstileToken ? { turnstileToken } : {}),
    });
  }

  async function fetchUser() {
    // 并发锁：如果已有进行中的请求，复用其 Promise
    if (fetchUserPromise) {
      return fetchUserPromise;
    }

    fetchUserPromise = (async () => {
      try {
        const response = await api.get('/auth/me');
        const data = response.data?.data;
        // 空值/结构校验：仅接受包含 id 的用户对象，结构异常时按未认证处理并记录日志，
        // 避免静默写入无效用户状态导致后续逻辑异常。
        if (data && typeof data === 'object' && (data as User).id) {
          user.value = data as User;
          lastFetchedAt = Date.now();
          // 命中封禁：服务端权威状态为封禁用户时，本地登出，防止继续访问受保护页面。
          // 由 router 守卫（G10-03）配合完成跳转。
          if ((data as User).isBanned) {
            console.warn('[Auth] /auth/me 返回封禁状态，本地登出');
            user.value = null;
          }
        } else {
          console.warn('[Auth] /auth/me 返回的用户数据结构异常，按未认证处理');
          user.value = null;
          lastFetchedAt = Date.now();
        }
      } catch (err: unknown) {
        // 区分 401（token 过期/无效）和网络错误（临时网络问题）
        // 仅 401 时清除用户状态，网络错误保留当前状态防止无故登出
        const axiosErr = err as { response?: { status?: number } };
        if (axiosErr?.response?.status === 401) {
          user.value = null;
        }
        // 403 = 已认证但无权限，保留用户状态，由调用方处理权限提示
      } finally {
        initialized.value = true;
        fetchUserPromise = null;
      }
    })();

    return fetchUserPromise;
  }

  async function logout() {
    try {
      await api.post('/auth/logout');
    } catch {
      // 即使请求失败也清除本地状态
    }
    user.value = null;
    // 与跨标签页接收端语义保持一致：登出后标记初始化已完成（已确认为登出状态）
    initialized.value = true;
    lastFetchedAt = 0;
    // 广播登出事件到其他标签页
    if (authChannel) {
      authChannel.postMessage('logout');
    }
  }

  return {
    user,
    initialized,
    isAuthenticated,
    login,
    register,
    sendCode,
    fetchUser,
    logout,
    closeAuthChannel,
    refreshIfStale,
    isSessionStale,
  };
});

export { api };
