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
    expect(out.startsWith('/api/s/[REDACTED]/preview/fid')).toBe(true);
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
    expect(sanitizeUrlForLog('/api/s/tok#section')).toBe('/api/s/[REDACTED]');
  });

  it('仅剩敏感参数时只保留 pathname', () => {
    expect(sanitizeUrlForLog('/api/s/tok/preview/fid?access=abc')).toBe('/api/s/[REDACTED]/preview/fid');
  });

  // 路径段凭据：/api/bot-dl/<下载Token> 与 /api/s/<分享Token> 可直接换取文件内容，
  // 历史上只清洗 query，这两个路径段被原样写入 access_logs 与 5xx 日志。
  it('脱敏 Bot 匿名直链路径中的下载 Token（保留路由模板）', () => {
    const token = 'A'.repeat(43);
    const out = sanitizeUrlForLog(`/api/bot-dl/${token}`);
    expect(out).toBe('/api/bot-dl/[REDACTED]');
    expect(out).not.toContain(token);
  });

  it('脱敏 Bot 直链路径并保留非敏感 query', () => {
    const token = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg';
    const out = sanitizeUrlForLog(`/api/bot-dl/${token}?v=2`);
    expect(out).toBe('/api/bot-dl/[REDACTED]?v=2');
    expect(out).not.toContain(token);
  });

  it('脱敏分享路径中的 Token 但保留后续资源段', () => {
    const token = 'shareTokenAbcDef1234567890';
    const out = sanitizeUrlForLog(`/api/s/${token}/download/file-1`);
    expect(out).toBe('/api/s/[REDACTED]/download/file-1');
    expect(out).not.toContain(token);
  });

  it('普通路径不被误伤', () => {
    expect(sanitizeUrlForLog('/api/files/abc/download')).toBe('/api/files/abc/download');
    expect(sanitizeUrlForLog('/api/bot-dl')).toBe('/api/bot-dl');
  });

  it('剥离缩略图访问令牌参数 t（G4-13）', () => {
    const out = sanitizeUrlForLog('/api/files/fid/thumbnail?t=abc123XYZ&v=2');
    expect(out).not.toContain('abc123XYZ');
    expect(out).toContain('v=2');
    expect(out).toContain('/api/files/fid/thumbnail');
  });

  it('仅剩 t 参数时只保留 pathname', () => {
    expect(sanitizeUrlForLog('/api/files/fid/thumbnail-hd?t=abc123')).toBe('/api/files/fid/thumbnail-hd');
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

  it('Referer 中的 Bot 下载路径同样脱敏', () => {
    const token = 'B'.repeat(43);
    expect(sanitizeRefererForLog(`https://text.lappland.top/api/bot-dl/${token}`))
      .toBe('https://text.lappland.top/api/bot-dl/[REDACTED]');
    expect(sanitizeRefererForLog(`https://text.lappland.top/api/s/${token}/preview/fid`))
      .toBe('https://text.lappland.top/api/s/[REDACTED]/preview/fid');
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
