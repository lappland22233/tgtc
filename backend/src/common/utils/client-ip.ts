import { Request } from 'express';
import { isIP } from 'net';

/**
 * 安全地提取真实客户端 IP 地址
 *
 * 仅信任 Express trust proxy 校验过的来源（req.ips / req.ip），
 * 不再直接信任 X-Real-IP / CF-Connecting-IP / X-Forwarded-For 等可被攻击者任意伪造的头部，
 * 避免攻击者伪造 IP 绕过 IP 维度的限流与封禁。
 *
 * trust proxy 配置（main.ts，G9-01）：
 * - 安全默认关闭（false）：req.ips 为空数组、req.ip 即 socket 直连地址，伪造的
 *   X-Forwarded-For 不会生效（直连场景下攻击者无法用伪造头绕过封禁）。
 * - 仅当部署位于反向代理之后且显式设置 TRUST_PROXY_HOPS 时才启用：此时 req.ips/req.ip
 *   为信任链过滤后的真实客户端 IP。
 *
 * 本函数不自行解析 X-Forwarded-For，完全依赖 Express 依据 trust proxy 配置产出的
 * req.ips / req.ip，因此 trust proxy 关闭时自然退化为 socket 直连地址，无需额外处理。
 */
export function getClientIp(req: Request): string {
  // 1. Express trust proxy 解析的 req.ips（信任链由 trust proxy 配置控制）
  //    trust proxy 开启时，req.ips[0] 为最远端客户端 IP（已过滤不可信代理）
  const hasProxy = req.ips && req.ips.length > 0;
  if (hasProxy) {
    const trustedClientIp = req.ips![0];
    if (isValidIp(trustedClientIp)) {
      return trustedClientIp;
    }
  }

  // 2. Express 的 req.ip（trust proxy 关闭时即 socket 直连地址，此时不受 XFF 伪造影响）
  if (req.ip && isValidIp(req.ip)) {
    return req.ip;
  }

  // 3. 直接连接 IP（兜底）
  const directIp = req.socket?.remoteAddress;
  if (directIp && isValidIp(directIp)) {
    return directIp;
  }

  return 'unknown';
}

function isValidIp(ip: string): boolean {
  // 剥离 IPv6 映射的 IPv4 前缀（::ffff:1.2.3.4），再用 net.isIP 严格校验，
  // 避免宽松正则放行 999.999.999.999 等非法地址
  const cleanIp = ip.replace(/^::ffff:/, '');
  return isIP(cleanIp) !== 0;
}

/** 解析 TRUST_PROXY_HOPS（与 main.ts 的 trust proxy 同一语义：未配置/非法＝0＝不信任任何代理）。 */
export function resolveTrustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw === '') return 0;
  const hops = Number(raw);
  return Number.isFinite(hops) && hops >= 0 ? hops : 0;
}

/**
 * socket.io 握手的真实客户端 IP，与 HTTP 侧 getClientIp 同一信任模型。
 *
 * WS 升级请求不经过 Express，req.ips/req.ip 不存在，必须自行按 trust proxy 语义解析。
 * **绝不取 X-Forwarded-For 首项**：那是客户端可任意伪造的值，未认证握手即可借此
 * 绕过握手限流、每 IP 并发上限与无效 token 封禁。
 *
 * hops=0（安全默认）时直接取 socket 对端地址，伪造头完全不生效。
 * hops>0 时取 XFF 链中 index = len - hops 的那一项——等价于 Express 数值型
 * trust proxy 产出的 req.ip（从 socket 往回数 hops 层即信任边界）。
 */
export function getSocketClientIp(
  remoteAddress: string | undefined,
  xff: string | string[] | undefined,
  hops: number,
): string | null {
  const direct = normalizeIp(remoteAddress);
  if (hops <= 0) return direct;
  const chain = (Array.isArray(xff) ? xff.join(',') : xff || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const index = chain.length - hops;
  if (index >= 0 && index < chain.length) {
    const candidate = normalizeIp(chain[index]);
    if (candidate) return candidate;
  }
  return direct;
}

function normalizeIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const clean = ip.replace(/^::ffff:/, '');
  return isIP(clean) !== 0 ? clean : null;
}
