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
