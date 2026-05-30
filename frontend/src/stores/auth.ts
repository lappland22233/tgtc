import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import axios from 'axios';
import type { User } from '../types/user';

export type SendCodeType = 'register' | 'reset_password';

let isRedirecting = false;
let redirectTimer: ReturnType<typeof setTimeout> | null = null;

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
});

// 401 响应拦截器：清空状态并跳转登录页（防抖处理）
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && !isRedirecting) {
      isRedirecting = true;
      // 从 pinia 实例获取当前 store
      const store = useAuthStore();
      // 仅清空状态，不发起额外请求
      store.user = null;
      // 防抖跳转，避免并发 401 多次触发
      if (redirectTimer) clearTimeout(redirectTimer);
      redirectTimer = setTimeout(() => {
        window.location.href = '/login';
        isRedirecting = false;
      }, 300);
    }
    return Promise.reject(error);
  },
);

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const initialized = ref(false);

  const isAuthenticated = computed(() => !!user.value);

  async function login(email: string, password: string) {
    const response = await api.post('/auth/login', { email, password });
    user.value = response.data.data.user as User;
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
