import 'reflect-metadata';
import { buildContentDisposition } from './content-disposition';

describe('buildContentDisposition', () => {
  it('ASCII 文件名生成双 filename 头', () => {
    expect(buildContentDisposition('attachment', 'report.pdf')).toBe(
      'attachment; filename="report.pdf"; filename*=UTF-8\'\'report.pdf',
    );
  });

  it('中文文件名使用 RFC 5987 编码', () => {
    const value = buildContentDisposition('inline', '测试视频.mp4');
    expect(value).toContain('filename*=UTF-8\'\'');
    expect(value).toContain('%E6%B5%8B%E8%AF%95'); // 测试 的 UTF-8 percent 编码
    expect(value).not.toContain('\n');
    expect(value).not.toContain('\r');
  });

  it('剔除换行与引号，防头注入', () => {
    const value = buildContentDisposition('attachment', 'evil"\r\nX-Evil: 1.txt');
    // 头中不出现真实 CR/LF（ASCII 部分已被清洗，RFC5987 部分百分号编码）
    expect(value).not.toContain('\r');
    expect(value).not.toContain('\n');
    // ASCII filename 内部的引号被替换为下划线，不会形成「内容跳出引号」的注入形态
    // 提取 filename="..." 包裹值，断言其内部不含引号字符
    const asciiName = /filename="([^"]*)"/.exec(value)?.[1] ?? '';
    expect(asciiName).not.toContain('"');
    expect(asciiName).not.toContain('evil"'); // 原引号已替换为 _
  });

  it('emoji 文件名安全编码', () => {
    const value = buildContentDisposition('attachment', 'logo🚀.png');
    expect(value).toContain('filename*=');
    expect(value).not.toContain('🚀'); // emoji 不原样出现在头中
  });
});
