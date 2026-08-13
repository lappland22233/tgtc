import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { buildProgressKey, readResumePoint, useMediaPlaybackStore } from './mediaPlayback';
import type { MediaSourceContext, MediaSession } from './mediaPlayback';

/** 内存版 localStorage（node 测试环境无真实实现） */
function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((k: string) => store.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => { store.set(k, v); }),
    removeItem: vi.fn((k: string) => { store.delete(k); }),
    key: vi.fn((i: number) => Array.from(store.keys())[i] ?? null),
    get length() { return store.size; },
    clear: vi.fn(() => store.clear()),
    _store: store,
  };
}

const userCtx: MediaSourceContext = { type: 'user', userId: 'user-1' };
const shareCtx: MediaSourceContext = { type: 'share', token: 'abc123' };
// 加密分享仅标记 encrypted，凭据存于后端 HttpOnly Cookie，前端不持有 accessJwt
const shareEncryptedCtx: MediaSourceContext = { type: 'share', token: 'abc123', encrypted: true };

describe('buildProgressKey', () => {
  it('登录态与分享态使用不同前缀', () => {
    expect(buildProgressKey(userCtx, 'file-1')).toContain(':u:user-1:file-1');
    expect(buildProgressKey(shareCtx, 'file-1')).toContain(':s:abc123:file-1');
  });

  it('不同用户的登录态进度互相隔离', () => {
    expect(buildProgressKey({ type: 'user', userId: 'user-1' }, 'file-1'))
      .not.toBe(buildProgressKey({ type: 'user', userId: 'user-2' }, 'file-1'));
  });

  it('分享访问凭据不参与进度键（不进 localStorage）', () => {
    expect(buildProgressKey(shareEncryptedCtx, 'file-1')).toBe(buildProgressKey(shareCtx, 'file-1'));
  });
});

describe('readResumePoint', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
  });

  it('无记录时从头播放', () => {
    expect(readResumePoint(userCtx, 'file-1')).toBe(0);
  });

  it('有效且满足阈值的进度点可恢复', () => {
    const key = buildProgressKey(userCtx, 'file-1');
    localStorage.setItem(key, JSON.stringify({ t: 60, d: 300, ts: Date.now() }));
    expect(readResumePoint(userCtx, 'file-1')).toBe(60);
  });

  it('接近结尾（不足 15 秒）不恢复，避免每次重看结尾', () => {
    const key = buildProgressKey(userCtx, 'file-1');
    localStorage.setItem(key, JSON.stringify({ t: 290, d: 300, ts: Date.now() }));
    expect(readResumePoint(userCtx, 'file-1')).toBe(0);
  });

  it('进度过短（不足 10 秒）不恢复', () => {
    const key = buildProgressKey(userCtx, 'file-1');
    localStorage.setItem(key, JSON.stringify({ t: 5, d: 300, ts: Date.now() }));
    expect(readResumePoint(userCtx, 'file-1')).toBe(0);
  });

  it('超过 duration 的记录视为损坏数据，不恢复', () => {
    const key = buildProgressKey(userCtx, 'file-1');
    localStorage.setItem(key, JSON.stringify({ t: 999, d: 300, ts: Date.now() }));
    expect(readResumePoint(userCtx, 'file-1')).toBe(0);
  });

  it('过期记录不恢复且被清除', () => {
    const key = buildProgressKey(userCtx, 'file-1');
    localStorage.setItem(key, JSON.stringify({ t: 60, d: 300, ts: Date.now() - 31 * 24 * 60 * 60 * 1000 }));
    expect(readResumePoint(userCtx, 'file-1')).toBe(0);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('损坏 JSON 不恢复且被清除', () => {
    const key = buildProgressKey(userCtx, 'file-1');
    localStorage.setItem(key, '{broken json');
    expect(readResumePoint(userCtx, 'file-1')).toBe(0);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('结构不完整（缺字段）不恢复且被清除', () => {
    const key = buildProgressKey(userCtx, 'file-1');
    localStorage.setItem(key, JSON.stringify({ t: 60 }));
    expect(readResumePoint(userCtx, 'file-1')).toBe(0);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('登录态与分享态进度互相隔离', () => {
    const userKey = buildProgressKey(userCtx, 'file-1');
    const shareKey = buildProgressKey(shareCtx, 'file-1');
    localStorage.setItem(userKey, JSON.stringify({ t: 60, d: 300, ts: Date.now() }));
    localStorage.setItem(shareKey, JSON.stringify({ t: 120, d: 300, ts: Date.now() }));
    expect(readResumePoint(userCtx, 'file-1')).toBe(60);
    expect(readResumePoint(shareCtx, 'file-1')).toBe(120);
  });

  it('版本匹配的记录可恢复', () => {
    const key = buildProgressKey(userCtx, 'file-1');
    localStorage.setItem(key, JSON.stringify({ t: 60, d: 300, ts: Date.now(), v: 2 }));
    expect(readResumePoint(userCtx, 'file-1', 2)).toBe(60);
  });

  it('覆盖上传后版本不匹配：旧进度失效并被清除', () => {
    const key = buildProgressKey(userCtx, 'file-1');
    localStorage.setItem(key, JSON.stringify({ t: 60, d: 300, ts: Date.now(), v: 1 }));
    expect(readResumePoint(userCtx, 'file-1', 2)).toBe(0);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('旧格式记录（无版本）遇到带版本的内容：一次性失效被清除', () => {
    const key = buildProgressKey(userCtx, 'file-1');
    localStorage.setItem(key, JSON.stringify({ t: 60, d: 300, ts: Date.now() }));
    expect(readResumePoint(userCtx, 'file-1', 1)).toBe(0);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('调用方未提供版本时旧格式记录仍按旧行为恢复（向后兼容）', () => {
    const key = buildProgressKey(userCtx, 'file-1');
    localStorage.setItem(key, JSON.stringify({ t: 60, d: 300, ts: Date.now() }));
    expect(readResumePoint(userCtx, 'file-1')).toBe(60);
  });
});

describe('useMediaPlaybackStore - 关闭/最小化分离与授权域', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', createMemoryStorage());
  });

  const makeSession = (overrides: Partial<MediaSession> = {}): MediaSession => ({
    context: { type: 'share', token: 'tok-a' },
    item: {
      id: 'file-1',
      name: 'demo.mp4',
      mimeType: 'video/mp4',
      kind: 'video',
      src: '/api/s/tok-a/preview/file-1',
      contentVersion: 1,
    },
    playlist: [],
    playlistIndex: -1,
    ...overrides,
  });

  it('最小化仅收起为迷你播放器，不停止媒体实例（H-01 保留）', () => {
    const store = useMediaPlaybackStore();
    const bridge = { stop: vi.fn(), play: vi.fn(), pause: vi.fn(), togglePlay: vi.fn(), seekTo: vi.fn(), seekBy: vi.fn(), next: vi.fn(), prev: vi.fn() };
    store.registerBridge(bridge);
    store.open(makeSession());

    store.minimize();
    expect(store.expanded).toBe(false);
    expect(store.session).not.toBeNull();
    expect(bridge.stop).not.toHaveBeenCalled();
  });

  it('关闭（requestStop）真正停止媒体并清空会话（H-01）', () => {
    const store = useMediaPlaybackStore();
    const bridge = { stop: vi.fn(), play: vi.fn(), pause: vi.fn(), togglePlay: vi.fn(), seekTo: vi.fn(), seekBy: vi.fn(), next: vi.fn(), prev: vi.fn() };
    store.registerBridge(bridge);
    store.open(makeSession());

    store.requestStop();
    expect(bridge.stop).toHaveBeenCalledTimes(1);
  });

  it('图片/PDF/文本类型最小化等价于停止（不进入迷你播放器）', () => {
    const store = useMediaPlaybackStore();
    const bridge = { stop: vi.fn(), play: vi.fn(), pause: vi.fn(), togglePlay: vi.fn(), seekTo: vi.fn(), seekBy: vi.fn(), next: vi.fn(), prev: vi.fn() };
    store.registerBridge(bridge);
    store.open(makeSession({
      item: { id: 'img-1', name: 'a.png', mimeType: 'image/png', kind: 'image', src: '/x.png' },
    }));

    store.minimize();
    expect(bridge.stop).toHaveBeenCalledTimes(1);
  });

  it('离开分享授权域（外部调用 requestStop）后会话清空', () => {
    const store = useMediaPlaybackStore();
    store.open(makeSession());
    expect(store.session?.context.type).toBe('share');

    store.requestStop();
    expect(store.session).toBeNull();
  });
});
