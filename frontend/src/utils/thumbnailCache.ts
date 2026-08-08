/**
 * 缩略图内存缓存（仅用于同一次页面渲染去重，不跨页面）
 * 本地缩略图文件已足够快，不再需要批量预加载。
 */
import { buildThumbUrl } from './thumbnail';

/** 缓存容量上限，超出按 LRU 淘汰，防止浏览大量文件夹时无限增长 */
const MAX_CACHE_SIZE = 500;
/**
 * 缓存有效期（毫秒）。
 * 缩略图 URL 内嵌签名 token（服务端 TTL 约 1.5s + ±2s 容差），
 * 缓存必须在该窗口内过期并重新构建，否则命中过期 URL 会大面积 403。
 */
const CACHE_TTL_MS = 1200;

interface CacheEntry {
  url: string;
  expiresAt: number;
}

/** Map 迭代序即插入/访问序，用于实现 LRU */
const cache = new Map<string, CacheEntry>();

/** in-flight 请求合并：同一 fileId 并发调用共享同一个构建 Promise，避免重复生成 token */
const pending = new Map<string, Promise<string>>();

/** 获取缩略图 URL（缓存命中返回已签名 URL，未命中返回单个 API URL） */
export async function getThumbnailUrl(fileId: string, mimeType?: string): Promise<string> {
  if (!mimeType?.startsWith('image/') && !mimeType?.startsWith('video/')) return '';

  const cached = cache.get(fileId);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      // 命中：删除后重新插入到末尾以刷新 LRU 访问序
      cache.delete(fileId);
      cache.set(fileId, cached);
      return cached.url;
    }
    // 过期项（签名 URL 已失效）清除后重新构建
    cache.delete(fileId);
  }

  // 请求合并：并发同 fileId 时复用同一个 Promise
  const inflight = pending.get(fileId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const url = await buildThumbUrl(fileId);
      cache.set(fileId, { url, expiresAt: Date.now() + CACHE_TTL_MS });
      // LRU 淘汰：超出容量时删除最久未访问项（Map 首部）
      while (cache.size > MAX_CACHE_SIZE) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
      }
      return url;
    } finally {
      pending.delete(fileId);
    }
  })();

  pending.set(fileId, promise);
  return promise;
}

/** 清除缓存 */
export function clearThumbnailCache() {
  cache.clear();
  pending.clear();
}
