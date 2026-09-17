// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDownloadsStore } from './downloads';

const triggerBrowserDownload = vi.fn();
const createDownloadTask = vi.fn();
const fetchDownloadTask = vi.fn();
const cancelDownloadTask = vi.fn();
const messageInfo = vi.fn();
const messageSuccess = vi.fn();
const messageError = vi.fn();

vi.mock('../utils/download', () => ({
  triggerBrowserDownload: (...args: unknown[]) => triggerBrowserDownload(...args),
}));

vi.mock('../api/download-task', () => ({
  createDownloadTask: (...args: unknown[]) => createDownloadTask(...args),
  fetchDownloadTask: (...args: unknown[]) => fetchDownloadTask(...args),
  cancelDownloadTask: (...args: unknown[]) => cancelDownloadTask(...args),
}));

vi.mock('../utils/message', () => ({
  default: {
    info: (...args: unknown[]) => messageInfo(...args),
    success: (...args: unknown[]) => messageSuccess(...args),
    error: (...args: unknown[]) => messageError(...args),
  },
}));

function queuedView(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'task-1',
    status: 'queued',
    queueReason: 'disk',
    queuePosition: 3,
    retryAfterMs: 1000,
    expectedSize: 1024,
    downloadUrl: '/api/files/f1/download',
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    message: '正在等待服务器释放磁盘空间，前面还有 2 个任务',
    ...overrides,
  };
}

describe('downloads store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useRealTimers();
    triggerBrowserDownload.mockReset();
    createDownloadTask.mockReset();
    fetchDownloadTask.mockReset();
    cancelDownloadTask.mockReset();
    messageInfo.mockReset();
    messageSuccess.mockReset();
    messageError.mockReset();
  });

  it('资源可用时立即触发浏览器原生下载，不进入队列视图', async () => {
    createDownloadTask.mockResolvedValueOnce({
      taskId: 'task-ready',
      status: 'streamable',
      expectedSize: 10,
      downloadUrl: '/api/files/f1/download',
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    });
    const store = useDownloadsStore();

    const job = await store.requestDownload({ fileId: 'f1', fileName: 'a.bin' });

    expect(job?.status).toBe('streamable');
    expect(triggerBrowserDownload).toHaveBeenCalledWith('/api/files/f1/download', 'a.bin');
    expect(store.jobs).toHaveLength(0);
    expect(store.hasActiveJobs).toBe(false);
  });

  it('服务器繁忙时进入排队并展示原因/位置，放行后自动触发下载', async () => {
    vi.useFakeTimers();
    createDownloadTask.mockResolvedValueOnce(queuedView());
    const store = useDownloadsStore();

    await store.requestDownload({ fileId: 'f1', fileName: 'big.bin' });
    expect(store.jobs).toHaveLength(1);
    expect(store.isServerBusy).toBe(true);
    expect(store.jobs[0].message).toContain('前面还有 2 个任务');
    expect(messageInfo).toHaveBeenCalled();

    fetchDownloadTask.mockResolvedValueOnce(queuedView({ message: '仍在等待服务器释放磁盘空间' }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetchDownloadTask).toHaveBeenCalledWith('task-1');
    expect(store.jobs).toHaveLength(1);

    fetchDownloadTask.mockResolvedValueOnce({
      taskId: 'task-1',
      status: 'streamable',
      expectedSize: 1024,
      downloadUrl: '/api/files/f1/download',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(1100);

    expect(triggerBrowserDownload).toHaveBeenCalledWith('/api/files/f1/download', 'big.bin');
    expect(messageSuccess).toHaveBeenCalled();

    // 完成后延迟移除任务
    await vi.advanceTimersByTimeAsync(2100);
    expect(store.jobs).toHaveLength(0);
    vi.useRealTimers();
  });

  it('同一文件的排队任务不会被重复创建', async () => {
    createDownloadTask.mockResolvedValueOnce(queuedView());
    const store = useDownloadsStore();

    await store.requestDownload({ fileId: 'f1', fileName: 'big.bin' });
    await store.requestDownload({ fileId: 'f1', fileName: 'big.bin' });

    expect(createDownloadTask).toHaveBeenCalledTimes(1);
    expect(messageInfo).toHaveBeenCalledWith('该文件已在下载队列中，请勿重复点击');
  });

  it('取消排队任务会调用取消接口并移除本地任务', async () => {
    createDownloadTask.mockResolvedValueOnce(queuedView());
    cancelDownloadTask.mockResolvedValueOnce(queuedView({ status: 'cancelled' }));
    const store = useDownloadsStore();

    await store.requestDownload({ fileId: 'f1', fileName: 'big.bin' });
    await store.cancel('task-1');

    expect(cancelDownloadTask).toHaveBeenCalledWith('task-1');
    expect(store.jobs).toHaveLength(0);
  });

  it('轮询失败时保留任务并提示重试，不静默丢失', async () => {
    vi.useFakeTimers();
    createDownloadTask.mockResolvedValueOnce(queuedView());
    fetchDownloadTask.mockRejectedValueOnce(new Error('network down'));
    const store = useDownloadsStore();

    await store.requestDownload({ fileId: 'f1', fileName: 'big.bin' });
    await vi.advanceTimersByTimeAsync(1100);

    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0].message).toContain('下载状态查询失败');
    store.stopAll();
    vi.useRealTimers();
  });

  it('stopAll 清理任务与定时器', async () => {
    vi.useFakeTimers();
    createDownloadTask.mockResolvedValueOnce(queuedView());
    const store = useDownloadsStore();
    await store.requestDownload({ fileId: 'f1', fileName: 'big.bin' });

    store.stopAll();
    expect(store.jobs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchDownloadTask).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
