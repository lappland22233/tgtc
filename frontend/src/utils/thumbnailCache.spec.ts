import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// thumbnail.ts → api/client → tdesign 引入 CSS，在 node 测试环境不可解析；本测试只测 Blob 缓存层，直接 mock
vi.mock('./thumbnail', () => ({
  buildThumbUrl: vi.fn(async () => '/api/files/x/thumbnail?t=token'),
  buildHdThumbUrl: vi.fn(async () => '/api/files/x/thumbnail-hd?t=token'),
}));

import {
  getThumbnailResource,
  releaseThumbnailResource,
  buildThumbResourceKey,
  clearBlobResourceCache,
} from './thumbnailCache';

const originalURL = globalThis.URL;

/** 模拟 Image：src setter 触发异步 onload，返回固定尺寸 */
class MockImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(_url: string) {
    queueMicrotask(() => {
      this.naturalWidth = 640;
      this.naturalHeight = 360;
      this.onload?.();
    });
  }
}

describe('thumbnailCache Blob 资源缓存', () => {
  const fetchMock = vi.fn();
  const revokeMock = vi.fn();
  let createObjectUrlCalls = 0;

  beforeEach(() => {
    createObjectUrlCalls = 0;
    fetchMock.mockReset();
    revokeMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Image', MockImage);
    vi.stubGlobal('URL', {
      ...originalURL,
      createObjectURL: vi.fn(() => `blob:mock-${++createObjectUrlCalls}`),
      revokeObjectURL: revokeMock,
    });
    clearBlobResourceCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const base = {
    context: 'u:user-1',
    fileId: 'file-1',
    version: 1,
    url: '/api/files/file-1/thumbnail?t=token',
  };

  it('首次获取 fetch 一次并返回 objectUrl 与尺寸', async () => {
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['fake']) });
    const res = await getThumbnailResource({ ...base });
    expect(res).not.toBeNull();
    expect(res!.objectUrl).toMatch(/^blob:/);
    expect(res!.width).toBe(640);
    expect(res!.height).toBe(360);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('同键并发请求合并为一次 fetch', async () => {
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['fake']) });
    const [r1, r2] = await Promise.all([
      getThumbnailResource({ ...base }),
      getThumbnailResource({ ...base }),
    ]);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('缓存命中不再 fetch；release 后仍复用缓存（LRU 保留未淘汰）', async () => {
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['fake']) });
    const key = buildThumbResourceKey({
      context: base.context,
      fileId: base.fileId,
      version: base.version,
      hd: false,
    });
    await getThumbnailResource({ ...base });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const again = await getThumbnailResource({ ...base });
    expect(again).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 释放引用后再次获取仍命中缓存（不重复下载）
    releaseThumbnailResource(key);
    const third = await getThumbnailResource({ ...base });
    expect(third).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('请求失败返回 null 且不缓存错误结果（避免错误 Promise 长期占位）', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    expect(await getThumbnailResource({ ...base })).toBeNull();
    expect(await getThumbnailResource({ ...base })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('缓存键隔离上下文 / 文件 / 版本 / 规格', () => {
    const keys = [
      buildThumbResourceKey({ context: 'u:user-1', fileId: 'f1', version: 1, hd: false }),
      buildThumbResourceKey({ context: 'u:user-2', fileId: 'f1', version: 1, hd: false }),
      buildThumbResourceKey({ context: 'u:user-1', fileId: 'f1', version: 2, hd: false }),
      buildThumbResourceKey({ context: 'u:user-1', fileId: 'f1', version: 1, hd: true }),
      buildThumbResourceKey({ context: 'u:user-1', fileId: 'f2', version: 1, hd: false }),
    ];
    expect(new Set(keys).size).toBe(5);
  });
});
