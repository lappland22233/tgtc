// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readCookie, withXsrfHeader, XSRF_HEADER_NAME } from './xsrf';

function clearCookies() {
  document.cookie.split(';').forEach((entry) => {
    const name = entry.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
}

describe('xsrf 工具（CSRF 双重提交）', () => {
  beforeEach(() => {
    clearCookies();
  });

  it('读取存在的 Cookie 并解码 URL 编码值', () => {
    document.cookie = 'XSRF-TOKEN=tok%2Fen';
    expect(readCookie('XSRF-TOKEN')).toBe('tok/en');
  });

  it('Cookie 不存在时返回空字符串', () => {
    expect(readCookie('XSRF-TOKEN')).toBe('');
  });

  it('Cookie 名称含正则特殊字符时不抛错', () => {
    expect(() => readCookie('a.b*c')).not.toThrow();
    expect(readCookie('a.b*c')).toBe('');
  });

  it('畸形编码值按无令牌处理（不抛错）', () => {
    document.cookie = 'XSRF-TOKEN=%E0%A4%A';
    expect(() => readCookie('XSRF-TOKEN')).not.toThrow();
    expect(readCookie('XSRF-TOKEN')).toBe('');
  });

  it('存在 Cookie 时注入请求头并保留基础头', () => {
    document.cookie = 'XSRF-TOKEN=token-abc';
    expect(withXsrfHeader({ 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
      [XSRF_HEADER_NAME]: 'token-abc',
    });
  });

  it('无 Cookie 时不注入请求头（匿名访客场景）', () => {
    const headers = withXsrfHeader({ 'Content-Type': 'application/json' });
    expect(headers[XSRF_HEADER_NAME]).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('调用方已显式设置该请求头时不覆盖', () => {
    document.cookie = 'XSRF-TOKEN=from-cookie';
    expect(withXsrfHeader({ [XSRF_HEADER_NAME]: 'explicit' })[XSRF_HEADER_NAME]).toBe('explicit');
  });

  it('不修改传入的请求头对象', () => {
    document.cookie = 'XSRF-TOKEN=token-abc';
    const base = { 'Content-Type': 'application/json' };
    withXsrfHeader(base);
    expect(base).toEqual({ 'Content-Type': 'application/json' });
  });
});
