import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgressKey, readResumePoint } from './mediaPlayback';
import type { MediaSourceContext } from './mediaPlayback';

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
const shareJwtCtx: MediaSourceContext = { type: 'share', token: 'abc123', accessJwt: 'secret-jwt' };

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
    expect(buildProgressKey(shareJwtCtx, 'file-1')).toBe(buildProgressKey(shareCtx, 'file-1'));
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
});
