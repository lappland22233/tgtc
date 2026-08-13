/**
 * Content-Disposition 头安全生成（RFC 6266 / RFC 5987）。
 *
 * 统一处理：
 * - filename="..."：仅 ASCII 安全字符，杜绝换行/引号注入（CR/LF 头注入防护）；
 * - filename*=UTF-8''...：RFC 5987 编码，支持中文等非 ASCII 文件名；
 * - 返回可直接放入响应头的完整值。
 */

/** 仅保留 ASCII 可打印字符（0x20-0x7E），剔除非 ASCII 与引号/反斜杠防止头注入 */
function asciiSafeName(name: string): string {
  return name
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

/** RFC 5987 编码：percent-encode 非 ASCII 与保留字符 */
function rfc5987Encode(value: string): string {
  let out = '';
  const buf = Buffer.from(value, 'utf8');
  for (const byte of buf) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9!#$&+-.^_`|~]/.test(ch)) {
      out += ch;
    } else {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/**
 * 生成 Content-Disposition 头值。
 * @param disposition inline | attachment
 * @param filename 原始文件名（可为中文/emoji）
 */
export function buildContentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const ascii = asciiSafeName(filename);
  const encoded = rfc5987Encode(filename);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
