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

  // 会话代际：登录/登出会使在途的 /auth/me 响应过期，
  // 防止迟到的恢复响应覆盖新的会话状态（如登出瞬间旧请求返回）。
  let sessionEpoch = 0;

  // ── 会话时效重拉（G10-05）──
  /** /auth/me 最近一次成功拉取的时间戳（ms）；未拉取过为 0 */
  let lastFetchedAt = 0;
  /** 会话 TTL（ms）：超过该时长后，页面回到前台 / 守卫时触发重拉 */
  const SESSION_REFRESH_TTL = 60 * 1000;
  /** 上次恢复失败的时间戳；0 表示无失败 */
  let lastFetchFailedAt = 0;
  /** 恢复失败后的最小重试间隔（ms）：防止断网期间每次导航都打 /auth/me */
  const RESTORE_RETRY_INTERVAL = 5 * 1000;

  /** 判断当前会话数据是否已过期、需要重拉 */
  function isSessionStale(): boolean {
    if (!initialized.value) return true;
    if (!user.value) {
      // 首次恢复遇到网络/服务临时失败 ≠ 确认匿名（401）：
      // 允许自然重试（导航/回前台触发），并做最小间隔节流防止请求风暴。
      return lastFetchFailedAt > 0 && Date.now() - lastFetchFailedAt >= RESTORE_RETRY_INTERVAL;
    }
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
        lastFetchFailedAt = 0;
        sessionEpoch++; // 使在途恢复响应过期
        // M7：跨标签页登出同样清理业务缓存，避免其他标签页残留旧账号数据。
        void resetSessionStores();
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

  async function fetchUser(options?: { timeoutMs?: number }) {
    // 并发锁：如果已有进行中的请求，复用其 Promise
    if (fetchUserPromise) {
      return fetchUserPromise;
    }

    // 独立超时（可选）：由守卫传入，超时 abort 底层请求使 Promise 尽快失败，
    // 而不是像外层 Promise 超时那样只放弃等待、请求仍挂起并被后续调用重复等待。
    const timeoutMs = options?.timeoutMs;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutController: AbortController | null = null;
    if (timeoutMs && timeoutMs > 0) {
      timeoutController = new AbortController();
      timeoutTimer = setTimeout(() => timeoutController?.abort(), timeoutMs);
    }

    const epochAtStart = sessionEpoch;
    fetchUserPromise = (async () => {
      try {
        const response = await api.get('/auth/me', timeoutController ? { signal: timeoutController.signal } : undefined);
        const data = response.data?.data;
        // 会话代际校验：请求期间发生登出（本地/跨标签页）则丢弃迟到响应
        if (epochAtStart !== sessionEpoch) {
          console.info('[Auth] /auth/me 响应到达时会话已变更，丢弃迟到响应');
          return;
        }
        // 空值/结构校验：仅接受包含 id 的用户对象，结构异常时按未认证处理并记录日志，
        // 避免静默写入无效用户状态导致后续逻辑异常。
        if (data && typeof data === 'object' && (data as User).id) {
          user.value = data as User;
          lastFetchedAt = Date.now();
          lastFetchFailedAt = 0;
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
          lastFetchFailedAt = 0;
        }
      } catch (err: unknown) {
        // 区分 401（token 过期/无效）和网络错误（临时网络问题）
        // 仅 401 时清除用户状态，网络错误保留当前状态防止无故登出
        const axiosErr = err as { response?: { status?: number } };
        if (axiosErr?.response?.status === 401) {
          user.value = null;
          lastFetchFailedAt = 0; // 明确匿名：无需自然重试
        } else {
          // 网络/超时/5xx：恢复暂时失败。首次加载时用户为 null 但不清 initialized，
          // 由 isSessionStale 允许后续导航/回前台自然重试（最小间隔节流）。
          lastFetchFailedAt = Date.now();
        }
        // 403 = 已认证但无权限，保留用户状态，由调用方处理权限提示
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        initialized.value = true;
        fetchUserPromise = null;
      }
    })();

    return fetchUserPromise;
  }

  /**
   * M7：登出/切换账号时清空所有会话相关的业务 store，避免旧账号缓存残留。
   *
   * - 先停止活跃副作用（上传队列、媒体播放与未完成请求）；
   * - 再清空业务缓存（文件列表、文件夹树、标签、按用户拉取的上传规则）；
   * - 动态 import 避免 store ↔ auth 的循环依赖（files/folders/tags 从本模块取 api 实例）；
   * - allSettled：清理是尽力而为，绝不能因某个 store 抛错而让用户登不出去。
   */
  async function resetSessionStores(): Promise<void> {
    await Promise.allSettled([
      import('./upload').then((m) => m.useUploadStore().reset()),
      import('./mediaPlayback').then((m) => m.useMediaPlaybackStore().reset()),
    ]);
    await Promise.allSettled([
      import('./files').then((m) => m.useFileStore().reset()),
      import('./folders').then((m) => m.useFolderStore().reset()),
      import('./tags').then((m) => m.useTagStore().reset()),
      import('./upload-config').then((m) => m.useUploadConfigStore().reset()),
    ]);
  }

  async function logout() {
    try {
      await api.post('/auth/logout');
    } catch {
      // 即使请求失败也清除本地状态
    }
    // M7：先清理业务缓存与副作用，再清空 auth 自身状态（顺序不可颠倒，
    // 否则清理过程中若有请求携带旧 Cookie 会与已清空的 user 状态不一致）。
    await resetSessionStores();
    user.value = null;
    // 与跨标签页接收端语义保持一致：登出后标记初始化已完成（已确认为登出状态）
    initialized.value = true;
    lastFetchedAt = 0;
    lastFetchFailedAt = 0;
    sessionEpoch++; // 使在途恢复响应过期，防止迟到响应覆盖登出状态
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
