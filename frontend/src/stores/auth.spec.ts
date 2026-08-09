import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  default: {},
  clearRedirectState: vi.fn(),
}));

import { getAuthResponseData } from './auth';

describe('认证响应适配', () => {
  it('登录响应不包含 accessToken 时仍可读取用户快照', () => {
    const user = {
      id: 'user-1',
      email: 'user@example.com',
      role: 'user' as const,
      emailVerified: true,
      isBanned: false,
      lastLoginAt: null,
      createdAt: '2026-08-09T00:00:00.000Z',
    };

    expect(getAuthResponseData({ data: { data: { user } } })).toEqual({ user });
  });

  it('注册待验证响应无需 token 或 user', () => {
    expect(getAuthResponseData({ data: { data: { needVerification: true, message: '请验证邮箱' } } })).toEqual({
      needVerification: true,
      message: '请验证邮箱',
    });
  });

  it('异常空响应安全回退为空对象', () => {
    expect(getAuthResponseData({})).toEqual({});
  });
});
