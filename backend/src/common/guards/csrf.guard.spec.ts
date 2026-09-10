import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { CsrfGuard } from './csrf.guard';
import { XSRF_COOKIE_NAME } from '../utils/xsrf';

/**
 * M1 回归：全局 CSRF 双重提交 + 同源校验。
 * 覆盖 Cookie 匹配、缺 Cookie、缺 Header、错配、跨站 Origin、Bearer/API Key 放行
 * 以及认证入口（尚无 XSRF Cookie）的处理。
 */
function makeContext(request: Partial<Request> & { method: string }): ExecutionContext {
  const req = {
    hostname: 'files.example.com',
    headers: {},
    path: '/api/files/1',
    ...request,
  } as unknown as Request;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('CsrfGuard（M1）', () => {
  let guard: CsrfGuard;

  beforeEach(() => {
    guard = new CsrfGuard();
    // 用例只关注 guard 自身语义，屏蔽安全事件日志噪声。
    jest.spyOn((guard as any).logger, 'warn').mockImplementation(() => undefined);
  });

  it('安全方法（GET/HEAD/OPTIONS）直接放行', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(guard.canActivate(makeContext({ method }))).toBe(true);
    }
  });

  it('无会话 Cookie 的 Bearer/API Key 写请求放行（不误伤非浏览器调用）', () => {
    expect(guard.canActivate(makeContext({
      method: 'POST',
      headers: { authorization: 'Bearer x' },
    }))).toBe(true);
  });

  it('无 Origin/Referer 且无会话 Cookie 放行', () => {
    expect(guard.canActivate(makeContext({ method: 'DELETE' }))).toBe(true);
  });

  it('Cookie 与 Header 匹配时放行', () => {
    expect(guard.canActivate(makeContext({
      method: 'POST',
      cookies: { access_token: 'session', [XSRF_COOKIE_NAME]: 'token-abc' },
      headers: { 'x-xsrf-token': 'token-abc' },
    }))).toBe(true);
  });

  it('缺少 XSRF Cookie 时拒绝', () => {
    expect(() => guard.canActivate(makeContext({
      method: 'POST',
      cookies: { access_token: 'session' },
      headers: { 'x-xsrf-token': 'token-abc' },
    }))).toThrow(ForbiddenException);
  });

  it('缺少 X-XSRF-TOKEN 请求头时拒绝', () => {
    expect(() => guard.canActivate(makeContext({
      method: 'POST',
      cookies: { access_token: 'session', [XSRF_COOKIE_NAME]: 'token-abc' },
      headers: {},
    }))).toThrow(ForbiddenException);
  });

  it('请求头与 Cookie 错配时拒绝', () => {
    expect(() => guard.canActivate(makeContext({
      method: 'PATCH',
      cookies: { access_token: 'session', [XSRF_COOKIE_NAME]: 'token-abc' },
      headers: { 'x-xsrf-token': 'token-xyz' },
    }))).toThrow(ForbiddenException);
  });

  it('跨站 Origin 优先拒绝（即使双提交凭据齐全）', () => {
    expect(() => guard.canActivate(makeContext({
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'x-xsrf-token': 'token-abc',
      },
      cookies: { access_token: 'session', [XSRF_COOKIE_NAME]: 'token-abc' },
    }))).toThrow(ForbiddenException);
  });

  it('认证入口在无 XSRF Cookie 时放行，但仍受同源校验保护', () => {
    expect(guard.canActivate(makeContext({
      method: 'POST',
      path: '/api/auth/login',
      headers: { origin: 'https://files.example.com' },
    }))).toBe(true);

    expect(() => guard.canActivate(makeContext({
      method: 'POST',
      path: '/api/auth/login',
      headers: { origin: 'https://evil.example' },
    }))).toThrow(ForbiddenException);
  });

  it('认证入口存在双提交凭据时仍比对，错配即拒绝', () => {
    expect(() => guard.canActivate(makeContext({
      method: 'POST',
      path: '/api/auth/logout',
      cookies: { access_token: 'session', [XSRF_COOKIE_NAME]: 'token-abc' },
      headers: { 'x-xsrf-token': 'token-xyz' },
    }))).toThrow(ForbiddenException);
  });

  it('公开分享的 GET 读取接口不套用写请求规则', () => {
    expect(guard.canActivate(makeContext({ method: 'GET', path: '/api/s/tok123' }))).toBe(true);
  });
});
