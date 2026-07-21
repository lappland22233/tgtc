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

/** 判断当前是否在无需 401 重定向的页面（登录/注册/密码重置/公开分享页） */
function isAuthPage(): boolean {
  const path = window.location.pathname;
  // 公开分享页 /s/:token 为匿名访问场景：分享接口返回 401（如密码错误/链接受限）时，
  // 不应把匿名访客强制跳转到登录页，故一并排除。
  return (
    path === '/login' ||
    path === '/register' ||
    path === '/reset-password' ||
    path.startsWith('/s/')
  );
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
  // CSRF 双重提交 Cookie（Double-Submit Cookie）配置：
  // axios 会在发起请求时读取名为 XSRF-TOKEN 的 cookie，并自动写入 X-XSRF-TOKEN 请求头。
  // ⚠️ 需后端配合：在登录/会话建立时下发一个名为 XSRF-TOKEN（非 httpOnly）的随机令牌 cookie，
  //    并在所有状态变更接口校验请求头 X-XSRF-TOKEN 与该 cookie 一致。
  // 若后端尚未下发该 cookie，前端读取为空时不会注入请求头、也不会报错（见下方请求拦截器，容错处理）。
  xsrfCookieName: 'XSRF-TOKEN',
  xsrfHeaderName: 'X-XSRF-TOKEN',
  // 不设置 Content-Type，由 axios 根据请求数据类型自动推断：
  // - 普通对象 → application/json
  // - FormData → multipart/form-data（浏览器自动设置 boundary）
});

/**
 * 读取指定名称的 cookie 值；不存在时返回空字符串（容错，不抛错）。
 * 用于 CSRF 双重提交 Cookie 方案。
 */
function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  // 转义 cookie 名中的正则特殊字符，避免构造非法正则
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + escaped + '=([^;]*)'));
  return match && match[1] ? decodeURIComponent(match[1]) : '';
}

// ---- 请求拦截器 ----
client.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // Cookie 由 axios withCredentials 自动携带，无需手动添加 Authorization header。
    // CSRF 防护（双重提交 Cookie）：读取后端下发的 XSRF-TOKEN cookie 并注入 X-XSRF-TOKEN 请求头。
    // ⚠️ 需后端配合下发该 cookie；此处做了容错——cookie 不存在时不注入请求头、也不报错，
    //    因此在后端尚未启用该机制前不会影响现有请求。
    const headers = config.headers;
    if (headers && !headers.has('X-XSRF-TOKEN')) {
      const xsrfToken = readCookie('XSRF-TOKEN');
      if (xsrfToken) {
        headers.set('X-XSRF-TOKEN', xsrfToken);
      }
    }
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
        // 注意：此处仅识别 Cloudflare 非 JSON 错误页并给出友好提示，并未实现自动重试，
        // 文案如实表述为“请稍后重试”，避免误导用户以为正在自动恢复。
        const cloudflareMsg = status === 413
          ? '文件过大（超过代理层 100MB 限制），请使用 80MB 以内的文件'
          : status === 502
            ? '上传超时（CDN 代理层 100 秒限制），请稍后重试'
            : status === 520 || status === 521 || status === 522 || status === 523 || status === 524
              ? '源站暂时不可用，请稍后重试'
              : `CDN 代理层错误 (${status})，请稍后重试`;
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
