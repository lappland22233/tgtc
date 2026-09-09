// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../api/client', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

import api from '../api/client';
import { usePublicConfigStore, DEFAULT_SITE_TITLE } from './public-config';

/** 刷新微任务队列 */
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('public-config store（网站标题单一来源）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    document.title = DEFAULT_SITE_TITLE;
  });

  it('读取成功：标题与浏览器标签同步更新', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: { siteTitle: '  自定义站点  ' } } });
    const store = usePublicConfigStore();

    await expect(store.fetchSiteTitle()).resolves.toBe(true);

    expect(store.siteTitle).toBe('自定义站点');
    expect(store.loaded).toBe(true);
    expect(document.title).toBe('自定义站点');
  });

  it('非字符串 / 空白标题回退默认值', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: { siteTitle: '   ' } } });
    const store = usePublicConfigStore();
    await store.fetchSiteTitle();
    expect(store.siteTitle).toBe(DEFAULT_SITE_TITLE);
    expect(document.title).toBe(DEFAULT_SITE_TITLE);

    vi.mocked(api.get).mockResolvedValue({ data: { data: { siteTitle: 42 } } });
    await store.fetchSiteTitle();
    expect(store.siteTitle).toBe(DEFAULT_SITE_TITLE);
  });

  it('读取失败返回 false 并保留最后成功值，不阻塞调用方', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('network down'));
    const store = usePublicConfigStore();
    store.setSiteTitle('已保存标题');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(store.fetchSiteTitle()).resolves.toBe(false);
    expect(store.siteTitle).toBe('已保存标题');
    expect(document.title).toBe('已保存标题');
    warn.mockRestore();
  });

  it('并发读取合并为单个在途请求', async () => {
    let resolveRequest: (value: unknown) => void = () => {};
    vi.mocked(api.get).mockImplementation(
      () => new Promise((resolve) => { resolveRequest = resolve; }),
    );
    const store = usePublicConfigStore();

    const first = store.fetchSiteTitle();
    const second = store.fetchSiteTitle();
    expect(api.get).toHaveBeenCalledTimes(1);

    resolveRequest({ data: { data: { siteTitle: '合并请求' } } });
    await flushMicrotasks();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(store.siteTitle).toBe('合并请求');

    // 在途请求结束后再调用 → 发起新请求
    vi.mocked(api.get).mockResolvedValue({ data: { data: { siteTitle: '再次' } } });
    await store.fetchSiteTitle();
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('竞态保护：保存后到期的旧读取响应不会覆盖新标题', async () => {
    let resolveRequest: (value: unknown) => void = () => {};
    vi.mocked(api.get).mockImplementation(
      () => new Promise((resolve) => { resolveRequest = resolve; }),
    );
    const store = usePublicConfigStore();

    const inflight = store.fetchSiteTitle();
    // 请求在途时保存成功
    store.setSiteTitle('刚保存的新标题');
    resolveRequest({ data: { data: { siteTitle: '过期旧标题' } } });
    await inflight;

    expect(store.siteTitle).toBe('刚保存的新标题');
    expect(document.title).toBe('刚保存的新标题');
  });

  it('setSiteTitle 规范化输入：trim、空值回退，并同步浏览器标签', () => {
    const store = usePublicConfigStore();

    store.setSiteTitle('  新标题  ');
    expect(store.siteTitle).toBe('新标题');
    expect(document.title).toBe('新标题');

    store.setSiteTitle('   ');
    expect(store.siteTitle).toBe(DEFAULT_SITE_TITLE);
    expect(document.title).toBe(DEFAULT_SITE_TITLE);
  });
});
