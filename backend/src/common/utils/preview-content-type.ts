/**
 * 预览响应防 XSS 加固。
 *
 * 两套独立决策：
 * 1. sanitizePreviewContentType —— 受保护预览（登录/分享）的 MIME 降级：
 *    将可能执行脚本的标记类型（text/html、image/svg+xml、各类 xml）强制降级为
 *    text/plain，配合 X-Content-Type-Options: nosniff 阻止浏览器把上传内容渲染为活动文档。
 * 2. isSafePublicInlineContentType —— 公开 /media 直链的可内联白名单：
 *    只允许经内容探测确认的安全位图与受支持音视频；SVG、XML、HTML、脚本型内容
 *    以及任何 MIME/魔数不一致的类型一律不允许 inline，杜绝持久型 XSS 面。
 */

/** 受保护预览下允许内联的安全位图类型（小写、无参数） */
const SAFE_PUBLIC_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
]);

/** 受支持的安全视频类型（小写、无参数） */
const SAFE_PUBLIC_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
]);

/** 受支持的安全音频类型（小写、无参数） */
const SAFE_PUBLIC_AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/aac',
  'audio/mp4',
  'audio/flac',
  'audio/x-m4a',
]);

/**
 * 受保护预览（登录/分享）：将可能执行脚本的标记类型强制降级为 text/plain。
 * 先剥离 MIME 参数（如 charset/version）再比较，防止 "text/html; charset=utf-8" 等带参声明绕过降级。
 */
export function sanitizePreviewContentType(contentType: string): string {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'text/html' || type === 'image/svg+xml' || type.includes('xml')) {
    return 'text/plain';
  }
  return contentType;
}

/**
 * 公开媒体直链（/media/:id）是否允许以 inline 返回。
 *
 * 仅允许白名单内的安全位图与受支持音视频。SVG（image/svg+xml）、XML、HTML、
 * 以及任何不在白名单内的 image/video/audio 类型一律返回 false，调用方必须拒绝 inline。
 *
 * @param contentType 数据库记录的 MIME 类型（可为带参数形式）
 * @param detectedExtension 可选：上传时 magic bytes 探测出的扩展名；若存在且与 MIME 家族不符则视为不安全
 */
export function isSafePublicInlineContentType(
  contentType: string,
  detectedExtension?: string | null,
): boolean {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  const safe =
    SAFE_PUBLIC_IMAGE_TYPES.has(type) ||
    SAFE_PUBLIC_VIDEO_TYPES.has(type) ||
    SAFE_PUBLIC_AUDIO_TYPES.has(type);
  if (!safe) return false;

  // MIME 家族与 magic bytes 探测结果一致性校验（纵深防御）：
  // 声明 image/* 但实际是脚本/文档类文件时，不允许以图片内联。
  if (detectedExtension) {
    const ext = detectedExtension.toLowerCase();
    if (type.startsWith('image/') && !/^(png|jpe?g|gif|webp|avif|bmp|ico)$/.test(ext)) return false;
    if (type.startsWith('video/') && !/^(mp4|m4v|webm|ogv|mov)$/.test(ext)) return false;
    if (type.startsWith('audio/') && !/^(mp3|m4a|ogg|oga|wav|webm|aac|flac)$/.test(ext)) return false;
  }
  return true;
}
