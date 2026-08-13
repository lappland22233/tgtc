import 'reflect-metadata';
import { parseByteRange, buildContentRange } from './byte-range';

describe('parseByteRange - closed range', () => {
  it('解析合法 closed range', () => {
    const r = parseByteRange('bytes=0-499', 1000);
    expect(r.ok && r.range).toMatchObject({ start: 0, end: 499, suffix: false });
  });

  it('end 超出 size 时钳制到 size-1', () => {
    const r = parseByteRange('bytes=0-9999', 1000);
    expect(r.ok && r.range).toMatchObject({ start: 0, end: 999 });
  });

  it('start >= size 判定为不可满足', () => {
    const r = parseByteRange('bytes=1000-1001', 1000);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('unsatisfiable');
  });

  it('start > end 为语法错误', () => {
    const r = parseByteRange('bytes=100-99', 1000);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('syntax');
  });
});

describe('parseByteRange - open-ended range', () => {
  it('解析合法 open-ended range', () => {
    const r = parseByteRange('bytes=500-', 1000);
    expect(r.ok && r.range).toMatchObject({ start: 500, end: 999 });
  });

  it('无 size 时返回 end=Infinity', () => {
    const r = parseByteRange('bytes=500-');
    expect(r.ok && r.range).toMatchObject({ start: 500, end: Infinity });
  });

  it('start >= size 判定为不可满足', () => {
    const r = parseByteRange('bytes=1000-', 1000);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('unsatisfiable');
  });
});

describe('parseByteRange - suffix range（修复原缺陷：合法 suffix 不再被拒）', () => {
  it('解析合法 suffix range', () => {
    const r = parseByteRange('bytes=-500', 1000);
    expect(r.ok && r.range).toMatchObject({ start: 500, end: 999, suffix: true });
  });

  it('suffix >= size 时返回整个文件', () => {
    const r = parseByteRange('bytes=-9999', 1000);
    expect(r.ok && r.range).toMatchObject({ start: 0, end: 999 });
  });

  it('suffix=0 为语法错误', () => {
    const r = parseByteRange('bytes=-0', 1000);
    expect(r.ok).toBe(false);
  });
});

describe('parseByteRange - 非法输入', () => {
  it('空值/undefined 为语法错误', () => {
    expect(parseByteRange(undefined, 1000).ok).toBe(false);
    expect(parseByteRange('', 1000).ok).toBe(false);
    expect(parseByteRange('   ', 1000).ok).toBe(false);
  });

  it('multi-range 判定为 multipart', () => {
    const r = parseByteRange('bytes=0-1,3-4', 1000);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('multipart');
  });

  it('错误单位/垃圾尾随为 unit 错误', () => {
    expect(parseByteRange('items=0-1', 1000).ok).toBe(false);
    expect(parseByteRange('bytes=0-1x', 1000).ok).toBe(false);
    expect(parseByteRange('bytes=abc', 1000).ok).toBe(false);
    expect(parseByteRange('bytes=', 1000).ok).toBe(false);
    expect(parseByteRange('bytes=-', 1000).ok).toBe(false);
  });

  it('超长 header 拒绝', () => {
    const huge = 'bytes=0-' + '9'.repeat(300);
    expect(parseByteRange(huge, 1000).ok).toBe(false);
  });

  it('非数字起始为语法错误', () => {
    expect(parseByteRange('bytes=a-1', 1000).ok).toBe(false);
  });
});

describe('buildContentRange', () => {
  it('生成 RFC 7233 头', () => {
    expect(buildContentRange(0, 499, 1000)).toBe('bytes 0-499/1000');
  });
});
