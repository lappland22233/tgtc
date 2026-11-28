/** 默认会话有效期：7 天（与 JWT_EXPIRES_IN 缺省值一致） */
const DEFAULT_EXPIRES_IN = '7d';

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000,
};

/**
 * C-07：把 `JWT_EXPIRES_IN` 解析为毫秒，供会话 Cookie 的 maxAge 使用。
 *
 * 此前 access_token 与 XSRF-TOKEN 的 maxAge 都硬编码 7 天，而 JWT 有效期可配置：
 * - 配 `30d` 时 Cookie 7 天先失效，令牌仍有效但用户被登出（体验错位）；
 * - 配 `1h` 时 Cookie 仍留 7 天，浏览器持续发送早已过期的令牌，表现为莫名 401。
 *
 * 支持 jsonwebtoken 的常见写法：`'7d'` / `'1h'` / `'30m'` / `'60s'` / `'500ms'` /
 * `'2w'` / `'1y'`，以及纯数字（秒）。非法值回退默认 7 天，与 JwtModule 的
 * `|| '7d'` 缺省保持一致。
 */
export function jwtExpiryMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.JWT_EXPIRES_IN || DEFAULT_EXPIRES_IN).trim();
  const fallback = UNIT_MS.d * 7;

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallback;
  }

  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)$/i.exec(raw);
  if (!match) return fallback;
  const value = Number(match[1]);
  const unit = UNIT_MS[match[2].toLowerCase()];
  if (!Number.isFinite(value) || value <= 0 || !unit) return fallback;
  return Math.round(value * unit);
}