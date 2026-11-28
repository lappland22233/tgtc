import { getSocketClientIp, resolveTrustProxyHops } from './client-ip';

describe('resolveTrustProxyHops', () => {
  it.each([
    [undefined, 0],
    ['', 0],
    ['0', 0],
    ['1', 1],
    ['2', 2],
    ['abc', 0],
    ['-1', 0],
  ])('TRUST_PROXY_HOPS=%s → %i（与 main.ts 同一安全默认）', (raw, expected) => {
    const env = raw === undefined ? {} : { TRUST_PROXY_HOPS: raw };
    expect(resolveTrustProxyHops(env as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe('getSocketClientIp（C-03 回归：WS 握手不得信任伪造 XFF 首项）', () => {
  it('hops=0（安全默认）时取 socket 对端地址，完全忽略伪造的 X-Forwarded-For', () => {
    expect(getSocketClientIp('203.0.113.9', '1.2.3.4, 5.6.7.8', 0)).toBe('203.0.113.9');
  });

  it('hops=0 且无 socket 地址时返回 null（不得回退到可伪造的头部）', () => {
    expect(getSocketClientIp(undefined, '1.2.3.4', 0)).toBeNull();
  });

  it('hops=1：nginx 追加真实客户端后，取信任边界那一项而非攻击者预置的首项', () => {
    // 攻击者预置 XFF: 1.2.3.4，nginx $proxy_add_x_forwarded_for 追加真实来源 203.0.113.9
    expect(getSocketClientIp('10.0.0.1', '1.2.3.4, 203.0.113.9', 1)).toBe('203.0.113.9');
  });

  it('hops=2：两层可信代理时取更左侧的真实客户端', () => {
    expect(getSocketClientIp('10.0.0.1', '198.51.100.7, 203.0.113.9', 2)).toBe('198.51.100.7');
  });

  it('hops 大于 XFF 链长度时回退 socket 地址，不越界取到 undefined', () => {
    expect(getSocketClientIp('10.0.0.1', '203.0.113.9', 5)).toBe('10.0.0.1');
  });

  it('剥离 IPv6 映射的 IPv4 前缀', () => {
    expect(getSocketClientIp('::ffff:203.0.113.9', undefined, 0)).toBe('203.0.113.9');
  });

  it('XFF 中的非法地址被拒绝并回退 socket 地址', () => {
    expect(getSocketClientIp('10.0.0.1', '999.999.999.999', 1)).toBe('10.0.0.1');
  });

  it('数组形式的 XFF 头与字符串形式等价', () => {
    expect(getSocketClientIp('10.0.0.1', ['1.2.3.4', '203.0.113.9'], 1)).toBe('203.0.113.9');
  });

  it('无 XFF 时即使 hops>0 也取 socket 地址', () => {
    expect(getSocketClientIp('203.0.113.9', undefined, 2)).toBe('203.0.113.9');
  });
});