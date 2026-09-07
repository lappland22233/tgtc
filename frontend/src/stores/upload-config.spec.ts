// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('./auth', () => ({
  api: { get: vi.fn() },
}));

import { api } from './auth';
import { useUploadConfigStore } from './upload-config';

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('upload-config store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
  });

  it('合并并发读取，并在完成后使用服务端真实字节限制', async () => {
    let resolveRequest: (value: unknown) => void = () => {};
    vi.mocked(api.get).mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const store = useUploadConfigStore();

    const first = store.fetchUploadConfig();
    const second = store.fetchUploadConfig();
    expect(api.get).toHaveBeenCalledTimes(1);

    resolveRequest({ data: { data: { maxFileSize: 2000 * 1024 * 1024, fileTypeMode: 'whitelist', fileTypeFilter: ['image/*', '.zip'], strictSerialUpload: true } } });
    await flushMicrotasks();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(store.config.maxFileSize).toBe(2000 * 1024 * 1024);
    expect(store.maxFileSizeMB).toBe(2000);
    expect(store.acceptTypes).toBe('image/*,.zip');
    expect(store.config.strictSerialUpload).toBe(true);
  });

  it('失败不标记为已加载，下一次调用可重试且保留默认安全值', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ data: { data: { maxFileSize: 2000 * 1024 * 1024 } } });
    const store = useUploadConfigStore();

    await expect(store.fetchUploadConfig()).resolves.toBe(false);
    expect(store.loaded).toBe(false);
    expect(store.config.maxFileSize).toBe(20 * 1024 * 1024);

    await expect(store.fetchUploadConfig()).resolves.toBe(true);
    expect(store.loaded).toBe(true);
    expect(store.config.maxFileSize).toBe(2000 * 1024 * 1024);
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('本地保存管理端限制时可保留严格串行上传策略', () => {
    const store = useUploadConfigStore();
    store.setConfig({ maxFileSize: 2000 * 1024 * 1024, strictSerialUpload: true });

    store.setConfig({
      maxFileSize: 1024 * 1024 * 1024,
      fileTypeMode: 'blacklist',
      fileTypeFilter: [],
      strictSerialUpload: store.config.strictSerialUpload,
    });

    expect(store.config.maxFileSize).toBe(1024 * 1024 * 1024);
    expect(store.config.strictSerialUpload).toBe(true);
  });
});
