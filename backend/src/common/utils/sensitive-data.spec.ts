import 'reflect-metadata';
import {
  sanitizeUrlForLog,
  sanitizeRefererForLog,
  isLikelyCredential,
} from './sensitive-data';

describe('sanitizeUrlForLog', () => {
  it('无 query 时原样返回规范化 pathname', () => {
    expect(sanitizeUrlForLog('/api/files/abc')).toBe('/api/files/abc');
  });

  it('剥离 access JWT 查询参数（C-02 核心）', () => {
    const raw = '/api/s/tok/preview/fid?access=eyJhbGciOiJIUzI1NiJ9.payload.sig';
    const out = sanitizeUrlForLog(raw);
    expect(out).not.toContain('access');
    expect(out).not.toContain('eyJhbGci');
    expect(out.startsWith('/api/s/tok/preview/fid')).toBe(true);
  });

  it('剥离 token/code/password 等敏感参数，保留普通参数', () => {
    const raw = '/api/auth/reset?password=secret&code=123456&page=2';
    const out = sanitizeUrlForLog(raw);
    expect(out).not.toContain('password');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('code');
    expect(out).toContain('page=2');
  });

  it('剥离 hash 片段', () => {
    expect(sanitizeUrlForLog('/api/s/tok#section')).toBe('/api/s/tok');
  });

  it('仅剩敏感参数时只保留 pathname', () => {
    expect(sanitizeUrlForLog('/api/s/tok/preview/fid?access=abc')).toBe('/api/s/tok/preview/fid');
  });

  it('空值返回根路径', () => {
    expect(sanitizeUrlForLog('')).toBe('/');
    expect(sanitizeUrlForLog(null)).toBe('/');
    expect(sanitizeUrlForLog(undefined)).toBe('/');
  });

  it('截断超长普通参数值', () => {
    const long = 'x'.repeat(500);
    const out = sanitizeUrlForLog(`/api/search?q=${long}`);
    expect(out.length).toBeLessThan(500 + 20);
    expect(out).not.toContain('x'.repeat(500));
  });
});

describe('sanitizeRefererForLog', () => {
  it('保留 origin + pathname，剥离 query 与 hash', () => {
    const ref = 'https://example.com/s/tok?access=secret#frag';
    expect(sanitizeRefererForLog(ref)).toBe('https://example.com/s/tok');
  });

  it('空值返回 null', () => {
    expect(sanitizeRefererForLog(null)).toBeNull();
    expect(sanitizeRefererForLog(undefined)).toBeNull();
  });

  it('非法 URL 时保守剥离 query', () => {
    const ref = '/s/tok?access=secret';
    const out = sanitizeRefererForLog(ref);
    expect(out).not.toContain('access');
  });
});

describe('isLikelyCredential', () => {
  it('识别 JWT 结构', () => {
    expect(isLikelyCredential('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.duX3dGJ5BzR2Y5s9iF0G4v7K2w8Lp0Qa')).toBe(true);
  });

  it('识别高熵长串', () => {
    expect(isLikelyCredential('a'.repeat(40))).toBe(true);
  });

  it('短值/普通值不误报', () => {
    expect(isLikelyCredential('abc')).toBe(false);
    expect(isLikelyCredential('')).toBe(false);
    expect(isLikelyCredential('page=2')).toBe(false);
  });
});
