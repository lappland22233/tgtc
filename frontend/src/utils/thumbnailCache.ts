/**
 * 缩略图内存缓存（仅用于同一次页面渲染去重，不跨页面）
 * 本地缩略图文件已足够快，不再需要批量预加载。
 */
import { buildThumbUrl } from './thumbnail';

const cache = new Map<string, string>();

/** 获取缩略图 URL（缓存命中返回 data URI，未命中返回单个 API URL） */
export async function getThumbnailUrl(fileId: string, mimeType?: string): Promise<string> {
  if (!mimeType?.startsWith('image/')) return '';

  const cached = cache.get(fileId);
  if (cached) return cached;

  const url = await buildThumbUrl(fileId);
  cache.set(fileId, url);
  return url;
}

/** 清除缓存 */
export function clearThumbnailCache() {
  cache.clear();
}
