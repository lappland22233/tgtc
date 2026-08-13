import { HttpException, BadRequestException } from '@nestjs/common';

/**
 * 在线预览 / 下载链路的 416 响应异常。
 *
 * 独立于 FileService 存放，供 controller 直接引用以设置 Content-Range 响应头。
 * - status: 416 Range Not Satisfiable
 * - total: 资源总长度，controller 用它生成 Content-Range 的 bytes 通配头
 */
export class RangeNotSatisfiableException extends HttpException {
  constructor(public readonly total: number) {
    super('Range 范围无效', 416);
  }
}

/** 编码分页游标：base64({ createdAt, id }) */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString('base64');
}

/** 解码游标（非法游标返回 400 而非 500） */
export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    if (
      !decoded ||
      typeof decoded.createdAt !== 'string' ||
      typeof decoded.id !== 'string' ||
      isNaN(Date.parse(decoded.createdAt))
    ) {
      throw new Error('游标结构非法');
    }
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch (err) {
    if (err instanceof BadRequestException) throw err;
    throw new BadRequestException('非法的分页游标');
  }
}

/** 转义 LIKE 通配符（% _ \），让用户关键词按字面匹配而非通配 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/**
 * 修复 Multer 中文文件名乱码：浏览器发送文件名时若未使用 RFC 5987 编码，
 * Multer/busboy 会将 UTF-8 字节误解析为 latin1，导致乱码。
 * 检测并修复：若文件名不含中文字符但含 latin1 高位字节，尝试 latin1->utf8 恢复。
 */
export function fixFilenameEncoding(originalName: string): string {
  // 已含中文字符 = 没有被误解析，直接返回
  if (/[\u4e00-\u9fff]/u.test(originalName)) {
    return originalName;
  }
  // 不含高位字节 = ASCII 文件名，无需修复
  if (!/[\x80-\xFF]/.test(originalName)) {
    return originalName;
  }
  // 尝试 latin1->utf8 恢复原始 UTF-8 编码
  const decoded = Buffer.from(originalName, 'latin1').toString('utf8');
  // 若恢复后包含 CJK 字符，说明原先被误解析了
  if (/[\u4e00-\u9fff]/u.test(decoded)) {
    return decoded;
  }
  return originalName;
}

/** 确保文件名有扩展名，若无则从 MIME 类型提取 */
export function ensureFileExtension(filename: string, mimeType: string): string {
  if (filename.includes('.')) return filename;
  const ext = mimeType.split('/')[1] || 'bin';
  return filename + '.' + ext;
}

/** 解析上传大小上限配置；非法值回退默认 20MB */
export function parseFileSize(val: string | undefined): number {
  const parsed = Number(val);
  return Number.isFinite(parsed) ? parsed : 20971520;
}

/** 解析访问次数配置；非法值回退 -1（不限次） */
export function parseAccessCount(val: string | undefined): number {
  const parsed = Number(val);
  return Number.isInteger(parsed) && parsed >= -1 ? parsed : -1;
}
