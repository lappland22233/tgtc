import { Request } from 'express';

/**
 * 安全地提取真实客户端 IP 地址
 * 优先使用 Express trust proxy 解析的 req.ips（需 app.set('trust proxy', ...) 配置），
 * 回退到可信代理头，最后使用直接连接 IP
 */
export function getClientIp(req: Request): string {
  // 1. Express trust proxy 解析的 req.ips（信任链由 trust proxy 配置控制）
  //    最后一个元素为最接近代理的 IP，防止客户端伪造 X-Forwarded-For
  if (req.ips && req.ips.length > 0) {
    const trustedClientIp = req.ips[0];
    if (isValidIp(trustedClientIp)) {
      return trustedClientIp;
    }
  }

  // 2. X-Real-IP（部分代理设置，较难伪造）
  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    const realIpStr = typeof realIp === 'string' ? realIp : realIp[0];
    if (realIpStr && isValidIp(realIpStr)) {
      return realIpStr;
    }
  }

  // 3. CF-Connecting-IP（Cloudflare，由 Cloudflare 边缘设置）
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp) {
    const cfIpStr = typeof cfIp === 'string' ? cfIp : cfIp[0];
    if (cfIpStr && isValidIp(cfIpStr)) {
      return cfIpStr;
    }
  }

  // 4. Express 的 req.ip（需 trust proxy 配置）
  if (req.ip && isValidIp(req.ip)) {
    return req.ip;
  }

  // 5. 直接连接 IP
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
