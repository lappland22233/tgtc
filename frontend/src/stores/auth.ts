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

  // 跨标签页登出同步
  if (typeof BroadcastChannel !== 'undefined') {
    const authChannel = new BroadcastChannel('auth-sync');
    authChannel.onmessage = (event) => {
      if (event.data === 'logout') {
        user.value = null;
        initialized.value = true;
      }
    };
  }

  async function login(email: string, password: string) {
    const response = await api.post('/auth/login', { email, password });
    user.value = response.data.data.user as User;
    clearRedirectState(); // 登录成功后重置重定向状态
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
    try {
      const response = await api.get('/auth/me');
      user.value = response.data.data as User;
    } catch {
      user.value = null;
    } finally {
      initialized.value = true;
    }
  }

  async function logout() {
    try {
      await api.post('/auth/logout');
    } catch {
      // 即使请求失败也清除本地状态
    }
    user.value = null;
    // 广播登出事件到其他标签页
    if (typeof BroadcastChannel !== 'undefined') {
      new BroadcastChannel('auth-sync').postMessage('logout');
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
  };
});

export { api };
