/**
 * IP 地址校验工具（G15-28）
 * 将 Config.vue 的严格 IPv6 校验提取为公共 util，供 Config.vue / SecurityMonitor.vue 等复用，
 * 避免各页各自维护宽松/严格不一致的正则。
 */

/** 严格 IPv4 校验：4 段 0-255，且无前导零（如 "01" 不合法） */
function isValidIPv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((o) => {
    const n = parseInt(o, 10);
    return n >= 0 && n <= 255 && String(n) === o;
  });
}

/**
 * 严格 IPv6 校验：
 * 8 组完整形式 / :: 压缩形式 / link-local（fe80::%iface）/ IPv4 映射与嵌入，
 * 避免宽松正则让 ":::" 等无效地址通过。
 */
function isValidIPv6(ip: string): boolean {
  const ipv6Re = /^(?:([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(?::[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]+|::(?:ffff(?::0{1,4})?:)?(?:(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])\.){3}(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])|(?:[0-9a-fA-F]{1,4}:){1,4}:(?:(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])\.){3}(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9]))$/;
  return ipv6Re.test(ip);
}

/** 校验 IP 是否为合法 IPv4 或 IPv6（G15-28 统一入口） */
export function isValidIP(ip: string): boolean {
  if (!ip) return false;
  const trimmed = ip.trim();
  return isValidIPv4(trimmed) || isValidIPv6(trimmed);
}
