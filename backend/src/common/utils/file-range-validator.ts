import { createHash } from 'crypto';

/**
 * 生成轻量、仅用于缓存验证的文件版本 ETag。
 * uploadVersion 在覆盖上传时递增；id/size 作为旧数据和异常场景的稳定兜底。
 */
export function buildFileVersionETag(file: {
  id: string;
  size?: number | string | null;
  uploadVersion?: number | string | null;
}): string {
  const version = file.uploadVersion ?? '0';
  const size = file.size ?? '0';
  const digest = createHash('sha1')
    .update(`${file.id}:${version}:${size}`)
    .digest('hex');
  return `"${digest}"`;
}

/** If-Range 只支持强 ETag 精确匹配；日期值交由后续版本扩展。 */
export function matchesIfRange(ifRange: string | undefined, etag: string): boolean {
  if (!ifRange) return true;
  return ifRange.trim() === etag;
}

/**
 * 生成不透明资源版本 ETag，用于没有 `uploadVersion` 的来源（如 Bot 匿名直链）。
 *
 * 只输出摘要，不回显 identity 原文（可能是 Telegram `file_id` 等内部标识）；
 * 同一 namespace + identity + size 必然得到同一 ETag，因此同一 Telegram 文件
 * 跨不同下载授权（grant）保持稳定，客户端可据此判断「续传的是同一版本」。
 */
export function buildOpaqueETag(
  namespace: string,
  identity: string,
  size?: number | string | null,
): string {
  const digest = createHash('sha256')
    .update(`${namespace}:${identity}:${size ?? '0'}`)
    .digest('hex');
  return `"${digest}"`;
}
