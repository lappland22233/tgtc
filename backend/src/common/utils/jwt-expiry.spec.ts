import { jwtExpiryMs } from './jwt-expiry';

/**
 * C-07：会话 Cookie 的 maxAge 必须与 JWT_EXPIRES_IN 对齐。
 * 此前两处硬编码 7 天：配 30d 时 Cookie 先失效（令牌有效却被登出），
 * 配 1h 时 Cookie 留 7 天（持续发送过期令牌，表现为莫名 401）。
 */
const WEEK = 7 * 24 * 3600 * 1000;

describe('jwtExpiryMs（C-07）', () => {
  it.each([
    ['7d', WEEK],
    ['1d', 86_400_000],
    ['30d', 30 * 86_400_000],
    ['1h', 3_600_000],
    ['30m', 1_800_000],
    ['60s', 60_000],
    ['500ms', 500],
    ['2w', 2 * 604_800_000],
    ['1y', 31_536_000_000],
  ])('解析 %s', (raw, expected) => {
    expect(jwtExpiryMs({ JWT_EXPIRES_IN: raw } as NodeJS.ProcessEnv)).toBe(expected);
  });

  it('纯数字按秒处理（jsonwebtoken 语义）', () => {
    expect(jwtExpiryMs({ JWT_EXPIRES_IN: '3600' } as NodeJS.ProcessEnv)).toBe(3_600_000);
  });

  it('大小写与首尾空白不敏感', () => {
    expect(jwtExpiryMs({ JWT_EXPIRES_IN: '  2H ' } as NodeJS.ProcessEnv)).toBe(7_200_000);
  });

  it('未配置时回退 7 天，与 JwtModule 的 || 7d 缺省一致', () => {
    expect(jwtExpiryMs({} as NodeJS.ProcessEnv)).toBe(WEEK);
    expect(jwtExpiryMs({ JWT_EXPIRES_IN: '' } as NodeJS.ProcessEnv)).toBe(WEEK);
  });

  it.each(['abc', '0', '-1', '0d', '7x', 'd', 'NaN'])(
    '非法值 %s 回退 7 天，不产生 0 或负 maxAge',
    (raw) => {
      const ms = jwtExpiryMs({ JWT_EXPIRES_IN: raw } as NodeJS.ProcessEnv);
      expect(ms).toBe(WEEK);
      expect(ms).toBeGreaterThan(0);
    },
  );

  it('小数时长取整到毫秒', () => {
    expect(jwtExpiryMs({ JWT_EXPIRES_IN: '1.5h' } as NodeJS.ProcessEnv)).toBe(5_400_000);
  });
});