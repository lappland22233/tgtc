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

async function startRedirect() {
  // 防止多次触发
  if (isRedirecting) {
    return;
  }
  isRedirecting = true;
  redirectTimer = setTimeout(async () => {
    if (!isAuthPage()) {
      const { default: router } = await import('../router');
      router.push('/login');
    }
    resetRedirectState();
  }, 300);
}

/** 判断当前是否在认证页面（登录/注册/密码重置） */
function isAuthPage(): boolean {
  const path = window.location.pathname;
  return path === '/login' || path === '/register' || path === '/reset-password';
}

// 查询是否正在重定向
export function isRedirectInProgress(): boolean {
  return isRedirecting;
}

// 恢复 redirect 状态（登录成功后调用）
export function clearRedirectState() {
  resetRedirectState();
}

// ---- 创建 axios 实例 ----
const client: AxiosInstance = axios.create({
  baseURL: '/api',
  // 默认 30 秒超时。文件上传请求应在调用处覆盖 timeout: 0
  // （使用后端 HTTP 服务器 10 分钟超时），避免大文件上传被中断
  timeout: 30000,
  withCredentials: true,
  // 不设置 Content-Type，由 axios 根据请求数据类型自动推断：
  // - 普通对象 → application/json
  // - FormData → multipart/form-data（浏览器自动设置 boundary）
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

    // Cloudflare 代理层错误（413 请求体过大 / 502 代理超时 / 5xx 源站错误）
    // 检测非 JSON 响应（Cloudflare HTML 错误页）
    if (status && status >= 400 && error.response?.data) {
      const contentType = error.response.headers?.['content-type']?.toString() || '';
      if (!contentType.includes('application/json')) {
        const cloudflareMsg = status === 413
          ? '文件过大（超过代理层 100MB 限制），请使用 80MB 以内的文件'
          : status === 502
            ? '上传超时（CDN 代理层 100 秒限制），正在自动重试...'
            : status === 520 || status === 521 || status === 522 || status === 523 || status === 524
              ? '源站暂时不可用，正在自动恢复...'
              : `CDN 代理层错误 (${status})，正在重试...`;
        return Promise.reject(new Error(cloudflareMsg));
      }
    }

    // 401 处理：防抖跳转登录页
    if (status === 401) {
      if (!isAuthPage() && !isRedirecting) {
        startRedirect();
      }
      return Promise.reject(error);
    }

    // 403 处理
    if (status === 403) {
      console.warn('[API] 无权访问此资源', error.config?.url);
      return Promise.reject(error);
    }

    // 410 Gone：分享链接已失效/过期/取消（Phase 2 新增）
    // 业务码由 ShareService 在分享不可用时抛 NotFoundException 返回，
    // 这里仅做友好的错误消息提取，具体 UI 由调用方展示
    if (status === 410) {
      const data = error.response?.data as { message?: string; code?: number } | undefined;
      const msg = data?.message || '此分享链接已失效';
      console.warn('[API] 分享链接已失效:', msg, error.config?.url);
      return Promise.reject(new Error(msg));
    }

    // 网络错误（无响应）
    if (!error.response) {
      console.warn('[API] 网络错误，请检查网络连接:', error.message || '未知错误');
      return Promise.reject(error);
    }

    // 服务器错误 (5xx)
    if (status && status >= 500) {
      console.warn('[API] 服务器错误，请稍后重试:', status, error.config?.url);
      return Promise.reject(error);
    }

    return Promise.reject(error);
  },
);

export default client;
