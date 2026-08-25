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
