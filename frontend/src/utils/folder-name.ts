/**
 * 文件夹名称 / 相对路径段校验工具。
 *
 * 用于"上传文件夹"入队前逐段校验目录名，避免把非法目录名提交给后端。
 * 校验规则同时覆盖 Windows / Linux 文件系统的保留字符与保留名称。
 */

/**
 * 白名单：字母（含中日韩等 Unicode 字母）、数字、连接符标点（下划线等）、
 * 空格、点、连字符，以及全角空格 \u3000 与全角点 \uFF0E。
 */
export const FOLDER_NAME_WHITELIST = /^[\p{L}\p{N}\p{Pc} .\-\u3000\uFF0E]+$/u;

/** 黑名单：Windows 文件名保留字符（<>:"/\|?*） */
export const FOLDER_NAME_BLACKLIST_CHARS = /[<>:"/\\|?*]/;

/** 特殊保留名称（精确匹配，一律拒绝） */
export const RESERVED_FOLDER_NAMES = ['.', '..'];

/** Windows 保留设备名前缀（不区分大小写、忽略扩展名，如 con.txt 也拒绝） */
export const WINDOWS_RESERVED_DEVICE_NAMES = [
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
];

/** 单个目录段的最大长度（与后端/常见文件系统 255 限制对齐） */
export const MAX_FOLDER_SEGMENT_LENGTH = 255;

/**
 * 校验单个目录段名称。
 * @returns 错误文案；合法时返回 null
 */
export function validateFolderSegment(name: string): string | null {
  // 空段 / 纯空白段
  if (name.length === 0) return '目录名不能为空';
  if (name.trim().length === 0) return '目录名不能为纯空白字符';

  // 特殊保留名称：'.' 与 '..' 一律拒绝
  if (RESERVED_FOLDER_NAMES.includes(name)) {
    return `不允许使用保留名称 "${name}"`;
  }

  // 段长度限制
  if (name.length > MAX_FOLDER_SEGMENT_LENGTH) {
    return `目录名长度不能超过 ${MAX_FOLDER_SEGMENT_LENGTH} 个字符`;
  }

  // 显式黑名单字符：给出精确提示（逐个列出命中的非法字符）
  const badChars = [...new Set(name.match(new RegExp(FOLDER_NAME_BLACKLIST_CHARS.source, 'g')) ?? [])];
  if (badChars.length > 0) {
    return `目录名包含非法字符：${badChars.map((c) => `"${c}"`).join(' ')}`;
  }

  // Windows 保留设备名：不区分大小写、忽略扩展名（如 con.txt）
  const baseName = name.split('.')[0].toUpperCase();
  if (WINDOWS_RESERVED_DEVICE_NAMES.includes(baseName)) {
    return `不允许使用保留名称 "${name}"（Windows 保留设备名）`;
  }

  // 白名单兜底：不在允许字符集内则拒绝
  if (!FOLDER_NAME_WHITELIST.test(name)) {
    return `目录名 "${name}" 包含不支持的字符`;
  }

  return null;
}

/** 相对路径逐段校验结果 */
export interface RelativePathValidation {
  ok: boolean;
  /** 首个违规段名称 */
  segment?: string;
  /** 首个违规段在 segments 中的位置 */
  index?: number;
  /** 违规原因文案 */
  reason?: string;
}

/**
 * 逐段校验相对路径（目录段数组），返回首个违规段与位置。
 * segments 为空（根级文件）视为合法。
 */
export function validateRelativePath(segments: string[]): RelativePathValidation {
  for (let i = 0; i < segments.length; i++) {
    const reason = validateFolderSegment(segments[i]);
    if (reason) {
      return { ok: false, segment: segments[i], index: i, reason };
    }
  }
  return { ok: true };
}
