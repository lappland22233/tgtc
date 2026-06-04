import axios, { type AxiosInstance, type AxiosError, type InternalAxiosRequestConfig } from 'axios';

// ---- 状态机：防止并发 401 重定向 ----
let isRedirecting = false;
let redirectTimer: ReturnType<typeof setTimeout> | null = null;

function resetRedirectState() {
  isRedirecting = false;
  if (redirectTimer) {
    clearTimeout(redirectTimer);
    redirectTimer = null;
  }
}

function startRedirect() {
  resetRedirectState();
  isRedirecting = true;
  redirectTimer = setTimeout(() => {
    window.location.href = '/login';
    // 页面即将跳转，状态将在恢复时重置
  }, 300);
}

// 恢复 redirect 状态（登录成功后调用）
export function clearRedirectState() {
  resetRedirectState();
}

// ---- 创建 axios 实例 ----
const client: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 30000,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ---- 请求拦截器 ----
client.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // Cookie 由 axios withCredentials 自动携带，无需手动添加 Authorization header
    // 延迟加载 authStore 以避免循环依赖
    return config;
  },
  (error: AxiosError) => {
    return Promise.reject(error);
  },
);

// ---- 响应拦截器 ----
client.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    const status = error.response?.status;

    // 401 处理：防抖跳转登录页
    if (status === 401) {
      const isAuthPage =
        window.location.pathname === '/login' ||
        window.location.pathname === '/register';

      if (!isAuthPage && !isRedirecting) {
        startRedirect();
      }
      return Promise.reject(error);
    }

    // 403 处理
    if (status === 403) {
      console.warn('[API] 无权访问此资源', error.config?.url);
      return Promise.reject(error);
    }

    // 网络错误（无响应）
    if (!error.response) {
      console.error('[API] 网络错误:', error.message);
      return Promise.reject(error);
    }

    // 服务器错误 (5xx)
    if (status && status >= 500) {
      console.error('[API] 服务器错误:', status, error.config?.url);
      return Promise.reject(error);
    }

    return Promise.reject(error);
  },
);

export default client;
