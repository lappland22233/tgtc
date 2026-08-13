/**
 * 缩略图 / 封面资源缓存（前端内存级）。
 *
 * 包含两层：
 * 1. 签名 URL 缓存：仅缓存已签名的访问 URL（TTL 很短，防止内嵌 token 过期后 403）。
 * 2. Blob / Object URL 缓存：fetch 响应字节缓存为 Blob 并提供受控 Object URL，
 *    供列表缩略图（ThumbnailImg）与视频预览封面（FilePreviewDialog）跨组件复用，
 *    消除同一资源在同一会话内的重复下载。
 *
 * 安全约定：
 * - 缓存键使用「访问上下文 + 文件 ID + 内容版本 + 规格」，不含 access JWT / Cookie 明文。
 * - 分享上下文使用公开 token 隔离；Blob 不保存任何 URL 或凭据。
 * - 淘汰 / 清理时统一调用 URL.revokeObjectURL 释放。
 */
import { buildThumbUrl, buildHdThumbUrl } from './thumbnail';

// ════════════ 第一层：签名 URL 缓存（原有逻辑） ════════════

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
export async function getThumbnailUrl(fileId: string, mimeType?: string, directUrl?: string): Promise<string> {
  if (!mimeType?.startsWith('image/') && !mimeType?.startsWith('video/')) return '';
  if (directUrl) return directUrl;
  return resolveThumbnailUrl(fileId, false);
}

/**
 * 获取高清封面 URL。
 * 使用独立的缓存命名空间（`hd:<fileId>`），避免与普通封面缓存键冲突，
 * 防止普通/高清封面在短 TTL 窗口内互相覆盖导致重复升级。
 */
export async function getHdThumbnailUrl(fileId: string, mimeType?: string): Promise<string> {
  if (!mimeType?.startsWith('video/')) return '';
  return resolveThumbnailUrl(fileId, true);
}

async function resolveThumbnailUrl(fileId: string, hd: boolean): Promise<string> {
  const key = hd ? `hd:${fileId}` : fileId;

  const cached = cache.get(key);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      // 命中：删除后重新插入到末尾以刷新 LRU 访问序
      cache.delete(key);
      cache.set(key, cached);
      return cached.url;
    }
    // 过期项（签名 URL 已失效）清除后重新构建
    cache.delete(key);
  }

  // 请求合并：并发同 key 时复用同一个 Promise
  const inflight = pending.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const url = hd ? await buildHdThumbUrl(fileId) : await buildThumbUrl(fileId);
      cache.set(key, { url, expiresAt: Date.now() + CACHE_TTL_MS });
      // LRU 淘汰：超出容量时删除最久未访问项（Map 首部）
      while (cache.size > MAX_CACHE_SIZE) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
      }
      return url;
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, promise);
  return promise;
}

// ════════════ 第二层：Blob / Object URL 资源缓存 ════════════

export interface BlobResource {
  /** 受控 Object URL（由缓存管理生命周期） */
  objectUrl: string;
  width: number;
  height: number;
}

export interface ThumbnailResourceOptions {
  /** 访问上下文标识（登录 `u:<userId>` / 分享 `s:<token>`），仅用于缓存键隔离，不含凭据 */
  context: string;
  fileId: string;
  /** 内容版本（覆盖上传时递增）；用于覆盖后使旧 Blob 缓存失效 */
  version?: string | number;
  /** true 表示高清封面规格，否则为标准缩略图 */
  hd?: boolean;
  /** 待下载资源的完整 URL（含签名 token 或分享 access JWT 查询参数） */
  url: string;
}

/** 缓存键组成部分（不含 URL / 凭据） */
export type ThumbResourceKeyParams = Pick<ThumbnailResourceOptions, 'context' | 'fileId' | 'version' | 'hd'>;

interface CachedBlobEntry {
  objectUrl: string;
  width: number;
  height: number;
  blob: Blob;
  expiresAt: number;
  /** 当前活跃引用数（尚未 release 的消费方） */
  refs: number;
  lastAccess: number;
}

const BLOB_CACHE_MAX_ENTRIES = 96;
const BLOB_CACHE_MAX_BYTES = 48 * 1024 * 1024; // 48MB
const BLOB_CACHE_TTL_MS = 10 * 60 * 1000;

const blobCache = new Map<string, CachedBlobEntry>();
let blobTotalBytes = 0;
/** in-flight 合并：同一缓存键并发 fetch 共享同一个 Promise，避免重复下载 */
const blobPending = new Map<string, Promise<BlobResource | null>>();

/** 构建资源缓存键（不含 URL / 凭据） */
export function buildThumbResourceKey(options: ThumbResourceKeyParams): string {
  return `${options.context}|${options.fileId}|${options.version ?? ''}|${options.hd ? 'hd' : 'thumb'}`;
}

/** 读取 Blob 的像素尺寸（失败返回 null） */
function readBlobDimensions(blob: Blob): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const probeUrl = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(probeUrl);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(probeUrl);
      resolve(null);
    };
    img.src = probeUrl;
  });
}

/** 移除单个缓存条目并释放 Object URL */
function removeBlobEntry(key: string) {
  const entry = blobCache.get(key);
  if (!entry) return;
  blobCache.delete(key);
  blobTotalBytes = Math.max(0, blobTotalBytes - entry.blob.size);
  URL.revokeObjectURL(entry.objectUrl);
}

/** 容量约束：先清理过期且未被引用的项，再按 LRU 淘汰未引用条目（refs=0）。
 * 正在渲染（refs>0）的条目即使过期也不 revoke，避免正在显示的图片/封面破图；
 * 等引用释放后由后续淘汰统一回收。 */
function evictBlobIfNeeded() {
  const now = Date.now();
  for (const [k, e] of [...blobCache.entries()]) {
    if (e.expiresAt <= now && e.refs === 0) removeBlobEntry(k);
  }
  while (blobCache.size > BLOB_CACHE_MAX_ENTRIES || blobTotalBytes > BLOB_CACHE_MAX_BYTES) {
    let victimKey: string | null = null;
    let oldest = Infinity;
    for (const [k, e] of blobCache) {
      if (e.refs > 0) continue; // 正在使用的条目不强制淘汰
      if (e.lastAccess < oldest) { oldest = e.lastAccess; victimKey = k; }
    }
    if (!victimKey) break;
    removeBlobEntry(victimKey);
  }
}

/**
 * 获取缩略图 / 封面 Blob 资源（受控 Object URL）。
 * - 同键并发请求合并为一个 fetch（in-flight Promise 去重）。
 * - 命中缓存直接返回（并递增引用计数），调用方使用后必须 releaseThumbnailResource 释放引用。
 * - 请求失败返回 null 且不缓存错误结果，避免错误 Promise 长期占位。
 */
export async function getThumbnailResource(
  options: ThumbnailResourceOptions,
): Promise<BlobResource | null> {
  const key = buildThumbResourceKey(options);

  // 返回值约定：返回非 null 时该 key 的引用计数必已 +1（调用方需配对 release）。
  // 最多重试一次，覆盖 in-flight 结果对应条目已被淘汰的极端竞态。
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = Date.now();
    const cached = blobCache.get(key);
    if (cached) {
      if (cached.expiresAt > now) {
        cached.refs++;
        cached.lastAccess = now;
        // 刷新 LRU 访问序
        blobCache.delete(key);
        blobCache.set(key, cached);
        return { objectUrl: cached.objectUrl, width: cached.width, height: cached.height };
      }
      removeBlobEntry(key);
    }

    const inflight = blobPending.get(key);
    if (inflight) {
      const result = await inflight;
      if (!result) return null;
      const entry = blobCache.get(key);
      if (entry) {
        entry.refs++;
        blobCache.delete(key);
        blobCache.set(key, entry);
        return result;
      }
      // 条目被淘汰（refs=0 + 容量/过期清理）：重走创建路径，保证返回前必有引用
      continue;
    }

    const promise = (async (): Promise<BlobResource | null> => {
      try {
        const res = await fetch(options.url, { credentials: 'same-origin' });
        if (!res.ok) return null;
        const blob = await res.blob();
        if (blob.size <= 0) return null;
        const dims = await readBlobDimensions(blob);
        if (!dims) return null;
        const objectUrl = URL.createObjectURL(blob);
        const entry: CachedBlobEntry = {
          objectUrl,
          width: dims.width,
          height: dims.height,
          blob,
          expiresAt: Date.now() + BLOB_CACHE_TTL_MS,
          refs: 1,
          lastAccess: Date.now(),
        };
        blobCache.set(key, entry);
        blobTotalBytes += blob.size;
        evictBlobIfNeeded();
        return { objectUrl, width: dims.width, height: dims.height };
      } catch {
        return null;
      } finally {
        blobPending.delete(key);
      }
    })();

    blobPending.set(key, promise);
    return promise;
  }
  return null;
}

/**
 * 释放对某资源的一次引用。refs 归零后条目仍保留在缓存中供复用，
 * 仅当容量 / TTL 压力到来时才被 LRU 淘汰并 revoke。
 */
export function releaseThumbnailResource(key: string): void {
  const entry = blobCache.get(key);
  if (entry && entry.refs > 0) entry.refs--;
}

/** 清除全部 Blob 资源缓存（登出 / 路由切换时调用），统一释放 Object URL */
export function clearBlobResourceCache() {
  for (const k of [...blobCache.keys()]) removeBlobEntry(k);
  blobPending.clear();
}

/** 清除缓存 */
export function clearThumbnailCache() {
  cache.clear();
  pending.clear();
  clearBlobResourceCache();
}
