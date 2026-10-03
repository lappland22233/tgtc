/**
 * CSRF 双重提交（Double-Submit Cookie）前端工具。
 *
 * 后端全局 `CsrfGuard` 对状态变更方法（非 GET/HEAD/OPTIONS）要求
 * `X-XSRF-TOKEN` 请求头与非 httpOnly 的 `XSRF-TOKEN` Cookie 常量时间相等；
 * 该校验只对**携带会话 Cookie** 的请求生效（Bearer / API Key 调用不受影响）。
 *
 * axios 实例（`api/client.ts`）已通过拦截器统一注入请求头，但少数公开页面
 * 出于不依赖 axios 的原因使用原生 `fetch`（例如分享页密码校验），必须显式
 * 调用本工具补齐请求头，否则**已登录访客**（浏览器自动携带 access_token Cookie）
 * 提交表单时会被 CSRF 校验拒绝（403）。
 */

export const XSRF_COOKIE_NAME = 'XSRF-TOKEN';
export const XSRF_HEADER_NAME = 'X-XSRF-TOKEN';

/**
 * 读取指定名称的 cookie 值；不存在时返回空字符串（容错，不抛错）。
 * 非浏览器环境（SSR / 测试）同样返回空字符串；值畸形编码（decodeURIComponent
 * 抛 URIError）时按「无令牌」处理，避免读取动作本身阻断请求。
 */
export function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  // 转义 cookie 名中的正则特殊字符，避免构造非法正则
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + escaped + '=([^;]*)'));
  if (!match || !match[1]) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

/**
 * 在给定请求头基础上补注入 CSRF 双重提交请求头。
 *
 * - Cookie 不存在时不注入（匿名访客 / 非浏览器调用），也不报错；
 * - 调用方已显式设置该请求头时不覆盖（保留显式优先语义）；
 * - 返回新对象，不修改传入的 `base`。
 */
export function withXsrfHeader(base: Record<string, string> = {}): Record<string, string> {
  if (base[XSRF_HEADER_NAME]) return { ...base };
  const token = readCookie(XSRF_COOKIE_NAME);
  return token ? { ...base, [XSRF_HEADER_NAME]: token } : { ...base };
}
