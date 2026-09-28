// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDownloadsStore, downloadStatusLabel } from './downloads';

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

  it('direct 模式在 streamable 后立即触发下载，展示直通提示且不进入队列', async () => {
    createDownloadTask.mockResolvedValueOnce({
      taskId: 'task-direct',
      status: 'streamable',
      mode: 'direct',
      expectedSize: 8 * 1024 * 1024 * 1024,
      // 就绪地址已自带一次性票据：前端直接使用，不自行拼接
      downloadUrl: '/api/files/f1/download?taskTicket=ticket-abc',
      ticket: 'ticket-abc',
      ticketExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    const store = useDownloadsStore();

    const job = await store.requestDownload({ fileId: 'f1', fileName: 'huge.iso' });

    expect(job?.mode).toBe('direct');
    expect(triggerBrowserDownload).toHaveBeenCalledWith(
      '/api/files/f1/download?taskTicket=ticket-abc',
      'huge.iso',
    );
    expect(messageSuccess).toHaveBeenCalledWith('已开始直通下载「huge.iso」（不占本地缓存）');
    // direct 是「可立即下载」，绝不进入排队视图
    expect(store.jobs).toHaveLength(0);
  });

  it('轮询到 direct-ready 时直接触发下载，并在指示器展示「直通下载」', async () => {
    vi.useFakeTimers();
    createDownloadTask.mockResolvedValueOnce(queuedView());
    const store = useDownloadsStore();
    await store.requestDownload({ fileId: 'f1', fileName: 'huge.iso' });
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0].status).toBe('queued');

    fetchDownloadTask.mockResolvedValueOnce({
      taskId: 'task-1',
      status: 'streamable',
      mode: 'direct',
      expectedSize: 8 * 1024 * 1024 * 1024,
      downloadUrl: '/api/files/f1/download?taskTicket=t2',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      message: '文件较大，将以直通方式下载（不占用本地缓存）',
    });
    await vi.advanceTimersByTimeAsync(1100);

    expect(triggerBrowserDownload).toHaveBeenCalledWith('/api/files/f1/download?taskTicket=t2', 'huge.iso');
    expect(store.jobs[0].mode).toBe('direct');
    expect(downloadStatusLabel(store.jobs[0])).toContain('直通下载');
    // 保留片刻后移除
    await vi.advanceTimersByTimeAsync(2100);
    expect(store.jobs).toHaveLength(0);
    vi.useRealTimers();
  });

  it('轮询退避遵守服务端 retryAfterMs（排队时按建议间隔再次查询）', async () => {
    vi.useFakeTimers();
    // 首次轮询按最小间隔 1s
    createDownloadTask.mockResolvedValueOnce(queuedView());
    const store = useDownloadsStore();
    await store.requestDownload({ fileId: 'f1', fileName: 'big.bin' });

    // 第 1 次轮询（t≈1000ms）返回 queued，建议间隔 3s → 下一次应在 t≈4000ms
    fetchDownloadTask.mockResolvedValueOnce(queuedView({ retryAfterMs: 3000 }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetchDownloadTask).toHaveBeenCalledTimes(1);

    // t=3000ms：仍未到下一次
    await vi.advanceTimersByTimeAsync(1900);
    expect(fetchDownloadTask).toHaveBeenCalledTimes(1);

    // t=4000ms：到达建议间隔后触发下一次
    fetchDownloadTask.mockResolvedValueOnce(queuedView({ retryAfterMs: 3000 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchDownloadTask).toHaveBeenCalledTimes(2);
    store.stopAll();
    vi.useRealTimers();
  });

  it('任务返回 cancelled 时停止轮询并提示已中断', async () => {
    vi.useFakeTimers();
    createDownloadTask.mockResolvedValueOnce(queuedView());
    const store = useDownloadsStore();
    await store.requestDownload({ fileId: 'f1', fileName: 'big.bin' });

    fetchDownloadTask.mockResolvedValueOnce(queuedView({ status: 'cancelled' }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(messageInfo).toHaveBeenCalledWith('下载任务已中断');
    expect(store.jobs).toHaveLength(1); // 保留片刻展示终态

    // 终态后不再轮询
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchDownloadTask).toHaveBeenCalledTimes(1);
    expect(store.jobs).toHaveLength(0);
    vi.useRealTimers();
  });

  it('任务返回 expired 时停止轮询并给出过期提示', async () => {
    vi.useFakeTimers();
    createDownloadTask.mockResolvedValueOnce(queuedView());
    const store = useDownloadsStore();
    await store.requestDownload({ fileId: 'f1', fileName: 'big.bin' });

    fetchDownloadTask.mockResolvedValueOnce(
      queuedView({ status: 'expired', message: '下载任务已过期，请重新发起下载' }),
    );
    await vi.advanceTimersByTimeAsync(1100);
    expect(messageError).toHaveBeenCalledWith('下载任务已过期，请重新发起下载');

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchDownloadTask).toHaveBeenCalledTimes(1);
    expect(store.jobs).toHaveLength(0);
    vi.useRealTimers();
  });

  it('取消以服务端返回状态为准：已交接（streamable）时取消不生效，不乐观置为 cancelled', async () => {
    vi.useFakeTimers();
    createDownloadTask.mockResolvedValueOnce(queuedView());
    // 服务端返回 streamable（预约已交给正文请求），取消不生效
    cancelDownloadTask.mockResolvedValueOnce(queuedView({ status: 'streamable' }));
    const store = useDownloadsStore();
    await store.requestDownload({ fileId: 'f1', fileName: 'big.bin' });

    await store.cancel('task-1');

    expect(messageInfo).toHaveBeenCalledWith('该下载已开始，取消未生效');
    expect(messageInfo).not.toHaveBeenCalledWith('已取消「big.bin」的下载排队');
    // 不乐观置为 cancelled：任务仍按服务端 streamable 状态保留片刻
    expect(store.jobs[0]?.status).toBe('streamable');
    await vi.advanceTimersByTimeAsync(2100);
    expect(store.jobs).toHaveLength(0);
    vi.useRealTimers();
  });

  it('取消失败时不误报成功，保留任务并恢复轮询', async () => {
    vi.useFakeTimers();
    createDownloadTask.mockResolvedValueOnce(queuedView());
    cancelDownloadTask.mockRejectedValueOnce(new Error('network down'));
    const store = useDownloadsStore();
    await store.requestDownload({ fileId: 'f1', fileName: 'big.bin' });

    await store.cancel('task-1');

    expect(messageError).toHaveBeenCalledWith('取消失败，请稍后重试');
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0].status).toBe('queued');
    store.stopAll();
    vi.useRealTimers();
  });

  it('downloadStatusLabel 逐状态区分（排队/就绪/直通/中断/过期）', () => {
    expect(downloadStatusLabel({
      status: 'queued', message: '', queueReason: 'upstream',
    })).toContain('排队中');
    expect(downloadStatusLabel({ status: 'streamable', message: '' })).toContain('已就绪');
    expect(downloadStatusLabel({ status: 'streamable', mode: 'direct', message: '' })).toContain('直通下载');
    expect(downloadStatusLabel({ status: 'cancelled', message: '' })).toBe('已中断');
    expect(downloadStatusLabel({ status: 'expired', message: '' })).toContain('已过期');
    // 严禁虚假完成态
    for (const label of [
      downloadStatusLabel({ status: 'streamable', message: '' }),
      downloadStatusLabel({ status: 'streamable', mode: 'direct', message: '' }),
    ]) {
      expect(label).not.toContain('下载成功');
    }
  });
});
