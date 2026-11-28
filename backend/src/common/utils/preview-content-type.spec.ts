import {
  sanitizePreviewContentType,
  isSafePublicInlineContentType,
} from './preview-content-type';

describe('sanitizePreviewContentType（C-04：脚本型 MIME 必须降级）', () => {
  it.each([
    'text/html',
    'image/svg+xml',
    'application/xml',
    'text/xml',
    'application/xhtml+xml',
  ])('标记型 %s 降级为 text/plain', (mime) => {
    expect(sanitizePreviewContentType(mime)).toBe('text/plain');
  });

  it.each([
    'text/javascript',
    'application/javascript',
    'application/x-javascript',
    'text/ecmascript',
    'application/ecmascript',
    'text/vbscript',
    'application/x-sh',
  ])('脚本型 %s 降级为 text/plain（此前只降级 html/svg/xml，漏掉这一类）', (mime) => {
    expect(sanitizePreviewContentType(mime)).toBe('text/plain');
  });

  it('带参数与大小写混写不得绕过降级', () => {
    expect(sanitizePreviewContentType('Text/JavaScript; charset=utf-8')).toBe('text/plain');
    expect(sanitizePreviewContentType('TEXT/HTML; charset=utf-8')).toBe('text/plain');
  });

  it('结构化 +javascript 后缀类型同样降级', () => {
    expect(sanitizePreviewContentType('application/ld+javascript')).toBe('text/plain');
  });

  it('安全位图与音视频保持原样', () => {
    expect(sanitizePreviewContentType('image/png')).toBe('image/png');
    expect(sanitizePreviewContentType('video/mp4')).toBe('video/mp4');
    expect(sanitizePreviewContentType('audio/mpeg')).toBe('audio/mpeg');
    expect(sanitizePreviewContentType('application/pdf')).toBe('application/pdf');
  });

  it('空值不抛错', () => {
    expect(sanitizePreviewContentType('')).toBe('');
  });
});

describe('isSafePublicInlineContentType（MIME 与魔数一致性）', () => {
  it('声明 image/* 但探测为脚本/文档扩展名时拒绝内联', () => {
    for (const ext of ['html', 'svg', 'js', 'xml', 'php']) {
      expect(isSafePublicInlineContentType('image/png', ext)).toBe(false);
    }
  });

  it('探测结果与 MIME 家族一致时允许内联', () => {
    expect(isSafePublicInlineContentType('image/png', 'png')).toBe(true);
    expect(isSafePublicInlineContentType('image/jpeg', 'jpg')).toBe(true);
    expect(isSafePublicInlineContentType('video/mp4', 'mp4')).toBe(true);
    expect(isSafePublicInlineContentType('audio/mpeg', 'mp3')).toBe(true);
  });

  it('无探测结果（存量文件）时只按白名单判定，不改变可用性', () => {
    expect(isSafePublicInlineContentType('image/png', null)).toBe(true);
    expect(isSafePublicInlineContentType('image/png')).toBe(true);
    expect(isSafePublicInlineContentType('text/html', null)).toBe(false);
  });

  it('白名单外的 image/video/audio 一律拒绝', () => {
    expect(isSafePublicInlineContentType('image/svg+xml', 'svg')).toBe(false);
    expect(isSafePublicInlineContentType('image/tiff', 'tiff')).toBe(false);
  });
});