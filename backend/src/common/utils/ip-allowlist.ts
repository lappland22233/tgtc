/**
 * IP 白名单匹配工具（v1.2.6）。
 *
 * 支持：
 * - IPv4 单地址 / CIDR（/0 - /32）
 * - IPv6 单地址 / CIDR（/0 - /128，含 :: 缩写与 IPv4-mapped 形式）
 * - 地址归一化：去除 zone index（fe80::1%eth0）、大小写
 *
 * 匹配语义：exact（单 IP）或前缀（CIDR）。空名单视为不限制（由调用方判定）。
 * 解析失败的规则按「不匹配」处理并返回错误明细，由调用方决定是否提示。
 */

export interface ParsedIpRule {
  ok: boolean;
  /** 规范化后的规则文本 */
  normalized: string;
  version: 4 | 6;
  /** 解析后的地址（BigInt，IPv4 为 32bit 值） */
  value: bigint;
  /** 前缀长度；单地址 = 全长 */
  prefix: number;
  error?: string;
}

/** 去除 IPv6 zone index 与大小写 */
export function normalizeIpString(ip: string): string {
  return ip.trim().replace(/%[0-9a-zA-Z]+$/, '').toLowerCase();
}

export function isIpv4(ip: string): boolean {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip);
}

function ipv4ToBigInt(ip: string): bigint | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  let value = 0n;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function ipv6ToBigInt(ip: string): bigint | null {
  // 处理 IPv4-mapped 尾部（::ffff:1.2.3.4）
  let text = ip;
  const v4Tail = text.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Tail) {
    const v4 = ipv4ToBigInt(v4Tail[2]);
    if (v4 === null) return null;
    const hi = (v4 >> 16n) & 0xffffn;
    const lo = v4 & 0xffffn;
    text = `${v4Tail[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }

  const doubleColonCount = (text.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;

  let head: string[] = [];
  let tail: string[] = [];
  if (doubleColonCount === 1) {
    const [h, t] = text.split('::');
    head = h ? h.split(':') : [];
    tail = t ? t.split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    const groups = [
      ...head,
      ...Array.from({ length: missing }, () => '0'),
      ...tail,
    ];
    return groupsToBigInt(groups);
  }

  const groups = text.split(':');
  if (groups.length !== 8) return null;
  return groupsToBigInt(groups);
}

function groupsToBigInt(groups: string[]): bigint | null {
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

/** 解析单条白名单规则（单 IP 或 CIDR） */
export function parseIpRule(rawRule: string): ParsedIpRule {
  const rule = normalizeIpString(rawRule);
  if (!rule) {
    return { ok: false, normalized: rule, version: 4, value: 0n, prefix: 0, error: '规则为空' };
  }

  const [addr, prefixText] = rule.split('/');
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) {
    return { ok: false, normalized: rule, version: 4, value: 0n, prefix: 0, error: '前缀长度格式非法' };
  }

  if (isIpv4(addr)) {
    const value = ipv4ToBigInt(addr);
    if (value === null) {
      return { ok: false, normalized: rule, version: 4, value: 0n, prefix: 0, error: 'IPv4 地址非法' };
    }
    const prefix = prefixText === undefined ? 32 : Number(prefixText);
    if (prefix > 32) {
      return { ok: false, normalized: rule, version: 4, value, prefix, error: 'IPv4 前缀长度不能超过 32' };
    }
    return { ok: true, normalized: prefixText === undefined ? addr : `${addr}/${prefix}`, version: 4, value, prefix };
  }

  const value = ipv6ToBigInt(addr);
  if (value === null) {
    return { ok: false, normalized: rule, version: 6, value: 0n, prefix: 0, error: 'IPv6 地址非法' };
  }
  const prefix = prefixText === undefined ? 128 : Number(prefixText);
  if (prefix > 128) {
    return { ok: false, normalized: rule, version: 6, value, prefix, error: 'IPv6 前缀长度不能超过 128' };
  }
  return { ok: true, normalized: prefixText === undefined ? addr : `${addr}/${prefix}`, version: 6, value, prefix };
}

/** 判断查询 IP 是否命中已解析规则（版本必须一致） */
export function ipMatchesRule(ip: string, parsed: ParsedIpRule): boolean {
  const normalized = normalizeIpString(ip);
  if (!normalized) return false;
  // 注意：解析的是「查询 IP」，parsed 中保存的是规则地址的网络值
  const [addr] = normalized.split('/');
  let value: bigint | null;
  let version: 4 | 6;
  if (isIpv4(addr)) {
    value = ipv4ToBigInt(addr);
    version = 4;
  } else {
    value = ipv6ToBigInt(addr);
    version = 6;
  }
  if (value === null || version !== parsed.version) return false;

  const fullBits = version === 4 ? 32n : 128n;
  const shift = fullBits - BigInt(parsed.prefix);
  // 前缀 0 时 shift = 全长，右移后两侧均为 0，恒匹配（语义正确）
  return value >> shift === parsed.value >> shift;
}

/** 便捷：IP 是否命中任一规则；全部规则解析失败时同样不匹配 */
export function ipInAllowlist(ip: string, rules: string[]): boolean {
  if (rules.length === 0) return true;
  return rules.some((rule) => {
    const parsed = parseIpRule(rule);
    return parsed.ok && ipMatchesRule(ip, parsed);
  });
}

/**
 * IP 脱敏展示（v1.2.6）：仅保留最前与最后一段。
 * - IPv4：192.168.1.2 → 192.*.*.2
 * - IPv6：2408:8456:1a2b::9f → 2408:*:*:*:*:*:*:9f（保留首末 hextet）
 */
export function maskIp(ip: string | null | undefined): string {
  if (!ip) return '';
  const normalized = normalizeIpString(ip);
  if (!normalized) return '';
  if (isIpv4(normalized)) {
    const parts = normalized.split('.');
    if (parts.length !== 4) return '***';
    return `${parts[0]}.*.*.${parts[3]}`;
  }
  // IPv6：展开 :: 后保留首末 hextet
  const expanded = expandIpv6ForMask(normalized);
  if (!expanded) return '***';
  const groups = expanded.split(':');
  return `${groups[0]}:${Array.from({ length: 6 }, () => '*').join(':')}:${groups[7]}`;
}

function expandIpv6ForMask(ip: string): string | null {
  const v4Tail = ip.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Tail) {
    const v4 = v4Tail[2].split('.').map(Number);
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    return expandIpv6ForMask(`${v4Tail[1]}${hi}:${lo}`);
  }
  const doubleColon = ip.includes('::');
  const groups = ip.split(':');
  if (doubleColon) {
    const idx = groups.indexOf('');
    const head = groups.slice(0, idx).filter(Boolean);
    const tail = groups.slice(idx).filter(Boolean);
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    return [...head, ...Array.from({ length: missing }, () => '0'), ...tail].join(':');
  }
  if (groups.length !== 8) return null;
  return groups.join(':');
}
