/**
 * 严格 HTTP Range 解析器（RFC 7233）。
 *
 * 仅支持单 range（bytes=first-last / bytes=first- / bytes=-suffix）：
 * - closed：bytes=0-99
 * - open-ended：bytes=500-
 * - suffix：bytes=-500（取文件末尾 500 字节）
 *
 * 明确拒绝：multi-range、错误单位（items=...）、尾随垃圾、空值、
 * 非数字、start>end、超长 header、负值前缀等。
 *
 * 解析结果统一为规范化的 { start, end }（0 基、含端点）。
 * 越界（start >= size）由调用方抛出 416 并返回正确 Content-Range。
 */

/** 单个 Range 头的最大字节数，超长视为攻击直接拒绝 */
const MAX_RANGE_HEADER_LENGTH = 256;

export interface ParsedByteRange {
  /** 起始字节（含） */
  start: number;
  /** 结束字节（含） */
  end: number;
  /** 是否 suffix 形式（bytes=-N） */
  suffix: boolean;
}

export type ByteRangeParseResult =
  | { ok: true; range: ParsedByteRange }
  | { ok: false; reason: 'syntax' | 'unit' | 'multipart' | 'unsatisfiable' };

/**
 * 解析单个 Range header。
 *
 * @param header 原始 Range 头值（可为 undefined/空）
 * @param size 资源总字节数；提供后做边界归约（suffix 换算、end 钳制到 size-1）
 * @returns 失败返回 reason；成功返回规范 range
 */
export function parseByteRange(
  header: string | undefined,
  size?: number,
): ByteRangeParseResult {
  if (!header || header.trim() === '') return { ok: false, reason: 'syntax' };
  if (header.length > MAX_RANGE_HEADER_LENGTH) return { ok: false, reason: 'syntax' };

  const trimmed = header.trim();
  const match = /^bytes=([0-9]+)?-([0-9]*)$/.exec(trimmed);
  if (!match) {
    // multi-range（bytes=0-1,2-3）或错误单位（items=...）等非法形式
    if (trimmed.startsWith('bytes=') && trimmed.includes(',')) return { ok: false, reason: 'multipart' };
    return { ok: false, reason: 'unit' };
  }

  const [, firstStr, lastStr] = match;
  // 二者皆空（bytes=- 或 bytes=-）视为语法错误
  if (firstStr === undefined && lastStr === '') return { ok: false, reason: 'syntax' };

  if (firstStr === undefined) {
    // suffix range: bytes=-N
    const suffix = Number(lastStr);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { ok: false, reason: 'syntax' };
    if (size === undefined) {
      // 无 size 时无法换算，返回原始语义（end 未知，由调用方处理）
      return { ok: true, range: { start: 0, end: Infinity, suffix: true } };
    }
    if (suffix >= size) {
      return { ok: true, range: { start: 0, end: size - 1, suffix: true } };
    }
    return { ok: true, range: { start: size - suffix, end: size - 1, suffix: true } };
  }

  const first = Number(firstStr);
  if (!Number.isSafeInteger(first) || first < 0) return { ok: false, reason: 'syntax' };

  if (lastStr === '') {
    // open-ended: bytes=first-
    if (size !== undefined && first >= size) return { ok: false, reason: 'unsatisfiable' };
    return { ok: true, range: { start: first, end: size !== undefined ? size - 1 : Infinity, suffix: false } };
  }

  const last = Number(lastStr);
  if (!Number.isSafeInteger(last) || last < first) return { ok: false, reason: 'syntax' };
  if (size !== undefined && first >= size) return { ok: false, reason: 'unsatisfiable' };
  // end 钳制到 size-1
  const end = size !== undefined && last >= size ? size - 1 : last;
  return { ok: true, range: { start: first, end, suffix: false } };
}

/** 生成 RFC 7233 Content-Range 头 */
export function buildContentRange(start: number, end: number, total: number): string {
  return `bytes ${start}-${end}/${total}`;
}
