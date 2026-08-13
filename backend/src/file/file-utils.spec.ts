import {
  RangeNotSatisfiableException,
  encodeCursor,
  decodeCursor,
  escapeLike,
  fixFilenameEncoding,
  ensureFileExtension,
  parseFileSize,
  parseAccessCount,
} from './file-utils';

describe('file-utils', () => {
  describe('RangeNotSatisfiableException', () => {
    it('返回 416 并携带 total', () => {
      const err = new RangeNotSatisfiableException(1000);
      expect(err.getStatus()).toBe(416);
      expect(err.total).toBe(1000);
    });
  });

  describe('游标编码/解码', () => {
    it('encode → decode 往返一致', () => {
      const createdAt = new Date('2026-08-13T12:00:00.000Z');
      const id = 'abc-123';
      const cursor = encodeCursor(createdAt, id);
      expect(decodeCursor(cursor)).toEqual({ createdAt: createdAt.toISOString(), id });
    });

    it('非法游标抛 400', () => {
      expect(() => decodeCursor('not-base64!!')).toThrow('非法的分页游标');
      expect(() => decodeCursor(Buffer.from('{"bad":1}').toString('base64'))).toThrow('非法的分页游标');
    });
  });

  describe('escapeLike', () => {
    it('转义 % _ 与反斜杠', () => {
      expect(escapeLike('50%_off\\x')).toBe('50\\%\\_off\\\\x');
      expect(escapeLike('plain')).toBe('plain');
    });
  });

  describe('fixFilenameEncoding', () => {
    it('中文文件名不做 latin1 恢复', () => {
      expect(fixFilenameEncoding('报告.pdf')).toBe('报告.pdf');
    });
    it('ASCII 文件名原样返回', () => {
      expect(fixFilenameEncoding('report.pdf')).toBe('report.pdf');
    });
    it('latin1 误解析的 UTF-8 中文恢复为中文', () => {
      const mojibake = Buffer.from('报告.pdf', 'utf8').toString('latin1');
      expect(fixFilenameEncoding(mojibake)).toBe('报告.pdf');
    });
  });

  describe('ensureFileExtension', () => {
    it('已含扩展名则不追加', () => {
      expect(ensureFileExtension('a.png', 'image/png')).toBe('a.png');
    });
    it('无扩展名时从 MIME 提取', () => {
      expect(ensureFileExtension('a', 'image/png')).toBe('a.png');
      expect(ensureFileExtension('b', 'application/octet-stream')).toBe('b.octet-stream');
    });
  });

  describe('parseFileSize', () => {
    it('合法值正常解析', () => {
      expect(parseFileSize('10485760')).toBe(10485760);
    });
    it('非法值回退默认 20MB', () => {
      expect(parseFileSize('abc')).toBe(20971520);
      expect(parseFileSize(undefined)).toBe(20971520);
    });
  });

  describe('parseAccessCount', () => {
    it('合法值正常解析', () => {
      expect(parseAccessCount('5')).toBe(5);
      expect(parseAccessCount('-1')).toBe(-1);
    });
    it('非法值回退 -1', () => {
      expect(parseAccessCount('abc')).toBe(-1);
      expect(parseAccessCount('-2')).toBe(-1);
    });
  });
});
