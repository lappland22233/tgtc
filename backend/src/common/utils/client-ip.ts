import { Request } from 'express';

/**
 * 安全地提取真实客户端 IP 地址
 *
 * 当 Express trust proxy 正确配置时，req.ips 数组包含经过验证的代理链，
 * 此时可信任反向代理设置的 X-Forwarded-* 等头部。
 * 在无反代环境中，这些头可能由攻击者伪造，因此直接依赖 req.ip/remoteAddress。
 */
export function getClientIp(req: Request): string {
  const hasProxy = req.ips && req.ips.length > 0;

  // 1. Express trust proxy 解析的 req.ips（信任链由 trust proxy 配置控制）
  //    trust proxy=1 时，req.ips[0] 为最远端客户端 IP（已过滤不可信代理）
  if (hasProxy) {
    const trustedClientIp = req.ips![0];
    if (isValidIp(trustedClientIp)) {
      return trustedClientIp;
    }
  }

  // 2. 仅在确认存在代理时才信任以下头部，否则直接跳到步骤 4
  if (hasProxy) {
    // X-Real-IP（部分反向代理设置）
    const realIp = req.headers['x-real-ip'];
    if (realIp) {
      const realIpStr = typeof realIp === 'string' ? realIp : realIp[0];
      if (realIpStr && isValidIp(realIpStr)) {
        return realIpStr;
      }
    }

    // CF-Connecting-IP（Cloudflare）
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) {
      const cfIpStr = typeof cfIp === 'string' ? cfIp : cfIp[0];
      if (cfIpStr && isValidIp(cfIpStr)) {
        return cfIpStr;
      }
    }
  }

  // 3. Express 的 req.ip（需 trust proxy 配置）
  if (req.ip && isValidIp(req.ip)) {
    return req.ip;
  }

  // 4. 直接连接 IP
  const directIp = req.socket?.remoteAddress;
  if (directIp && isValidIp(directIp)) {
    return directIp;
  }

  return 'unknown';
}

function isValidIp(ip: string): boolean {
  // 排除 IPv6 前缀格式
  const cleanIp = ip.replace(/^::ffff:/, '');
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  return ipv4Regex.test(cleanIp) || ipv6Regex.test(cleanIp);
}
