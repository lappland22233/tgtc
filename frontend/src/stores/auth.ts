import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '../api/client';
import { clearRedirectState } from '../api/client';
import type { User } from '../types/user';

export type SendCodeType = 'register' | 'reset_password';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const initialized = ref(false);

  const isAuthenticated = computed(() => !!user.value);

  // fetchUser 并发锁：防止 router beforeEach 触发重复请求
  let fetchUserPromise: Promise<void> | null = null;

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
    user.value = response.data.data.user as User;
    clearRedirectState(); // 登录成功后重置重定向状态
    // 二次验证：通过 fetchUser 获取服务端权威用户状态，防止响应篡改。
    // fetchUser 成功时会以 /auth/me 的权威数据覆盖上面来自响应体的 user；
    // 失败时不再静默吞错，至少记录告警便于排查（保留响应数据以不阻断登录流程）。
    try {
      await fetchUser();
    } catch (err) {
      console.warn('[Auth] 登录后获取权威用户信息失败，已保留登录响应数据:', err);
    }
    return response.data;
  }

  async function register(email: string, password: string, code: string) {
    const response = await api.post('/auth/register', { email, password, code });
    const data = response.data.data;
    // 邮箱验证开启时，后端不返回 token，需用户验证邮箱后再登录
    if (data.needVerification) {
      return response;
    }
    user.value = data.user as User;
    return response;
  }

  async function sendCode(email: string, type: SendCodeType) {
    return api.post('/auth/send-code', { email, type });
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
        } else {
          console.warn('[Auth] /auth/me 返回的用户数据结构异常，按未认证处理');
          user.value = null;
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
  };
});

export { api };
