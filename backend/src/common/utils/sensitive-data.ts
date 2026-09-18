/**
 * 集中敏感数据脱敏工具。
 *
 * 供访问日志、错误日志与管理导出共用同一套规则，保证
 * 分享访问 JWT、认证 token、密码、Cookie 或 Authorization 等凭据
 * 不会以明文形式进入任何持久化日志、导出或上报链路。
 */

/** 需要从 URL query 中移除的敏感参数名（小写匹配） */
const SENSITIVE_QUERY_PARAMS = new Set([
  'access',
  // 媒体票据会出现在受限预览 URL 中，必须始终从日志 URL 剥离。
  'ticket',
  'token',
  'code',
  'password',
  'pwd',
  'auth',
  'authorization',
  'key',
  'secret',
  'apikey',
  'api_key',
  'sign',
  'sig',
  // G2-19：补齐常见凭据参数名，覆盖 OAuth / JWT / 会话令牌等场景
  'access_token',
  'access-token',
  'jwt',
  'session',
  'session_id',
  'sessionid',
  'id_token',
  'idtoken',
  'refresh_token',
  'refresh-token',
  'bearer',
  'credential',
  'credentials',
  'client_secret',
  'clientsecret',
  'private_key',
  'privatekey',
  'accesstoken',
  'auth_token',
  'authtoken',
  // G4-13：缩略图访问令牌参数 `t`（旧 RSA 时间戳令牌 / 潜在凭据），
  // 虽已移除令牌校验，仍不应以明文形式进入访问日志。
  't',
]);

/** 超过此长度的 query 参数值不进入日志（防止大值/超长凭据撑爆存储） */
const MAX_QUERY_VALUE_LENGTH = 200;

/**
 * 需要脱敏的路径凭据规则（凭据位于 path 段，而非 query）。
 *
 * `/api/bot-dl/<下载Token>` 与 `/api/s/<分享Token>/...` 的路径段本身就是可直接
 * 换取文件内容的凭据：一旦被持久化到访问日志、5xx 日志或导出文件，任何能读到
 * 日志的人都能重放。清洗时保留路由模板（含后续资源 ID 段），只把凭据段替换为
 * `[REDACTED]`，使统计仍能按路由聚合。
 */
const SENSITIVE_PATH_SEGMENT_RULES: ReadonlyArray<{ match: RegExp; replacement: string }> = [
  { match: /^\/api\/bot-dl\/[^/]+/i, replacement: '/api/bot-dl/[REDACTED]' },
  { match: /^\/api\/s\/[^/]+/i, replacement: '/api/s/[REDACTED]' },
];

/** 把路径中的凭据段替换为 [REDACTED]（无匹配时原样返回） */
function redactSensitivePath(pathname: string): string {
  for (const rule of SENSITIVE_PATH_SEGMENT_RULES) {
    if (rule.match.test(pathname)) return pathname.replace(rule.match, rule.replacement);
  }
  return pathname;
}

/**
 * 清洗用于日志的请求 URL：
 * - 剥离 hash 片段；
 * - 路径中的凭据段（bot-dl Token / 分享 Token）替换为 [REDACTED]；
 * - 移除敏感 query 参数（access/token/code/password/...），其余参数保留；
 * - 超长 query 值截断。
 *
 * 返回值只包含规范化 pathname + 非敏感 query，不含任何凭据。
 */
export function sanitizeUrlForLog(rawUrl: string | undefined | null): string {
  if (!rawUrl) return '/';
  const [pathPart, queryPart] = rawUrl.split('?');
  const pathname = redactSensitivePath((pathPart || '/').split('#')[0] || '/');
  if (queryPart === undefined) return pathname;

  try {
    const params = new URLSearchParams(queryPart);
    let removed = false;
    for (const key of Array.from(params.keys())) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        params.delete(key);
        removed = true;
        continue;
      }
      const value = params.get(key) ?? '';
      if (value.length > MAX_QUERY_VALUE_LENGTH) {
        params.set(key, value.substring(0, MAX_QUERY_VALUE_LENGTH));
      }
    }
    const rest = params.toString();
    if (!rest) return pathname;
    // removed 仅作语义标记；返回时与原始 URL 形态保持一致（保留剩余参数）
    return removed ? `${pathname}?${rest}` : `${pathname}?${rest}`;
  } catch {
    return pathname;
  }
}

/**
 * 清洗 Referer：仅保留 origin + pathname，剥离 query 与 hash，
 * 并同样脱敏路径中的凭据段，防止访问凭据经 Referer 进入访问日志。
 */
export function sanitizeRefererForLog(referer: string | null | undefined): string | null {
  if (!referer) return null;
  try {
    const url = new URL(referer);
    return url.origin + redactSensitivePath(url.pathname);
  } catch {
    const cleaned = referer.split('?')[0].split('#')[0].trim();
    return cleaned ? redactSensitivePath(cleaned).substring(0, 300) : null;
  }
}

/**
 * 判断一段字符串是否为疑似访问凭据（用于检测敏感参数再次出现时的告警）。
 * 返回 true 表示应告警但不得记录该值本身。
 */
export function isLikelyCredential(value: string): boolean {
  if (!value) return false;
  if (value.length < 20) return false;
  // JWT 结构（header.payload.signature）
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return true;
  // 高熵 base64url / hex 长串
  if (/^[A-Za-z0-9_-]{32,}$/.test(value)) return true;
  return false;
}
