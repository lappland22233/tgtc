import { Request } from 'express';
import { isIP } from 'net';

/**
 * 安全地提取真实客户端 IP 地址
 *
 * 仅信任 Express trust proxy 校验过的来源（req.ips / req.ip），
 * 不再直接信任 X-Real-IP / CF-Connecting-IP 等可被攻击者任意伪造的头部，
 * 避免攻击者伪造 IP 绕过 IP 维度的限流与封禁。
 *
 * 部署在 Cloudflare/反向代理之后时，应确保：
 * 1. Express trust proxy 配置正确（本项目 main.ts 设为 1）；
 * 2. 上游代理正确设置 X-Forwarded-For，使 req.ips[0]/req.ip 为真实客户端 IP。
 */
export function getClientIp(req: Request): string {
  // 1. Express trust proxy 解析的 req.ips（信任链由 trust proxy 配置控制）
  //    trust proxy=1 时，req.ips[0] 为最远端客户端 IP（已过滤不可信代理）
  const hasProxy = req.ips && req.ips.length > 0;
  if (hasProxy) {
    const trustedClientIp = req.ips![0];
    if (isValidIp(trustedClientIp)) {
      return trustedClientIp;
    }
  }

  // 2. Express 的 req.ip（trust proxy 配置下为最远端可信客户端 IP）
  if (req.ip && isValidIp(req.ip)) {
    return req.ip;
  }

  // 3. 直接连接 IP（无反代环境下的兜底）
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
