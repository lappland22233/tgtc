// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 回归：严格小盘模式下服务器「串行上传名额被占用」返回的 429 必须被当作排队，
 * 按 retryAfterMs 继续等待并上报等待态；只有非排队类错误才走常规瞬时重试/失败。
 */

const postMock = vi.fn();
const getMock = vi.fn();

vi.mock('../api/client', () => ({
  default: {
    post: (...args: unknown[]) => postMock(...args),
    get: (...args: unknown[]) => getMock(...args),
  },
}));

import { useChunkedUpload } from './useChunkedUpload';

/** 后端 429 排队响应（顶层 code 为数字 HTTP 状态，业务码在 errorCode） */
function budgetBusyError(message = '服务器正在依次处理另一份大文件，本文件已自动排队，请保持页面打开') {
  return {
    response: {
      status: 429,
      headers: { 'x-tgtc-error-code': 'UPLOAD_DISK_BUDGET_BUSY', 'retry-after': '5' },
      data: { code: 429, errorCode: 'UPLOAD_DISK_BUDGET_BUSY', retryAfterMs: 5000, message },
    },
  };
}

function createFile(size = 1024): File {
  return new File([new Uint8Array(size)], '排队测试.mp4', { type: 'video/mp4' });
}

/** 统计 init 调用次数（排除 abort 等其它请求） */
function initCallCount(): number {
  return postMock.mock.calls.filter((call) => call[0] === '/files/chunk/init').length;
}

describe('useChunkedUpload 严格小盘排队等待', () => {
  beforeEach(() => {
    postMock.mockReset();
    getMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('init 遇到磁盘预算 429 时按服务器间隔排队重试，并成对上报等待态', async () => {
    postMock
      .mockRejectedValueOnce(budgetBusyError())
      .mockRejectedValueOnce(budgetBusyError())
      .mockResolvedValue({ data: { data: { uploadId: 'upload-1' } } });
    // init 成功后立刻查询分片状态：此处失败以终止流程，避免进入真实分片上传
    getMock.mockRejectedValue(new Error('stop-after-init'));

    const chunked = useChunkedUpload(1);
    const snapshots: boolean[] = [];
    const settled = chunked
      .uploadFile(createFile(), (p) => snapshots.push(p.waitingForSlot === true))
      .then(() => null, (err: unknown) => err as Error);

    // 首轮 429：进入等待并上报等待态
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toEqual([true]);

    // 等待 5s 后重试，仍被占用 → 等待态先清后置
    await vi.advanceTimersByTimeAsync(5000);
    expect(initCallCount()).toBe(2);
    expect(snapshots).toEqual([true, false, true]);

    // 名额释放：init 成功，等待态收敛为 false
    await vi.advanceTimersByTimeAsync(5000);
    expect(initCallCount()).toBe(3);
    expect(snapshots).toEqual([true, false, true, false]);

    expect((await settled)?.message).toContain('stop-after-init');
    expect(chunked.progress.value.waitingForSlot).toBe(false);
  });

  it('等待期间取消上传：立即中断等待并清理等待态', async () => {
    postMock.mockRejectedValue(budgetBusyError());

    const chunked = useChunkedUpload(1);
    const controller = new AbortController();
    const snapshots: boolean[] = [];
    const settled = chunked
      .uploadFile(createFile(), (p) => snapshots.push(p.waitingForSlot === true), controller.signal)
      .then(() => null, (err: unknown) => err as Error);

    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toEqual([true]);

    controller.abort();
    expect((await settled)?.message).toContain('上传已取消');
    expect(snapshots).toEqual([true, false]);
    // 取消后不得再排队重试
    await vi.advanceTimersByTimeAsync(60_000);
    expect(initCallCount()).toBe(1);
  });

  it('非排队类 429 不进入 5s 长等待，按常规重试次数上限失败', async () => {
    postMock.mockRejectedValue({
      response: { status: 429, headers: {}, data: { code: 429, message: '上传请求过多，请稍后重试' } },
    });

    const chunked = useChunkedUpload(1);
    const promise = chunked.uploadFile(createFile());
    const settled = promise.catch((err: unknown) => err);

    // 常规重试：MAX_RETRIES = 3，退避 2s/4s/8s（含 0-1s 抖动），共 4 次 init
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(settled).resolves.toBeTruthy();
    expect(initCallCount()).toBe(4);
  });

  it('排队等待超过上限后以排队语义失败，并清理等待态', async () => {
    postMock.mockRejectedValue(budgetBusyError());

    const chunked = useChunkedUpload(1);
    const snapshots: boolean[] = [];
    const settled = chunked
      .uploadFile(createFile(), (p) => snapshots.push(p.waitingForSlot === true))
      .then(() => null, (err: unknown) => err as Error);

    // MAX_DISK_BUDGET_RETRIES = 360 → 第 361 次仍被占用即放弃（360 次等待，每次 5s）
    await vi.advanceTimersByTimeAsync(5_000 * 361);

    const error = await settled;
    expect(error?.message).toContain('排队等待时间过长');
    expect(error?.message).not.toContain('磁盘');
    expect(initCallCount()).toBe(361);
    expect(snapshots[snapshots.length - 1]).toBe(false);
    expect(chunked.progress.value.waitingForSlot).toBe(false);
  });

  it('分片请求被串行名额挡住时同样上报等待态（分片级 429）', async () => {
    const chunkBusy = budgetBusyError('服务器正在接收上一分片，请稍候');
    let chunkCalls = 0;
    postMock.mockImplementation((url: string, body?: unknown, config?: unknown) => {
      if (url === '/files/chunk/init') {
        return Promise.resolve({ data: { data: { uploadId: 'upload-chunk' } } });
      }
      if (url === '/files/chunk/upload-chunk' && body instanceof FormData) {
        chunkCalls++;
        // 第一片先被严格租约挡住，重试即成功
        if (chunkCalls === 1) return Promise.reject(chunkBusy);
        return Promise.resolve({ data: { code: 0, data: null } });
      }
      if (url === '/files/chunk/upload-chunk/complete' || config) {
        return Promise.resolve({ data: { code: 0, data: null } });
      }
      return Promise.resolve({ data: { code: 0, data: null } });
    });
    getMock
      .mockResolvedValueOnce({ data: { data: { uploaded: [] } } })
      .mockResolvedValue({
        data: { data: { mergeStatus: 'done', mergeResult: { id: 'file-1', originalName: '排队测试.mp4' } } },
      });

    const chunked = useChunkedUpload(1);
    const snapshots: boolean[] = [];
    const settled = chunked.uploadFile(createFile(), (p) => snapshots.push(p.waitingForSlot === true));

    await vi.advanceTimersByTimeAsync(0);
    // 分片 429（同一业务码）应显示为排队等待，而不是只显示「重试」
    // （init 成功时会先上报一次 false，故此处只断言出现过等待态）
    expect(snapshots).toContain(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(chunkCalls).toBe(2);
    expect(snapshots[snapshots.length - 1]).toBe(false);

    // 合并轮询间隔 5s
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(settled).resolves.toEqual({ id: 'file-1', originalName: '排队测试.mp4' });
    expect(snapshots[snapshots.length - 1]).toBe(false);
  });

  it('合并长期处理中不会被误判为状态查询失败', async () => {
    postMock.mockImplementation((url: string) => Promise.resolve({ data: { data: url.endsWith('/init') ? { uploadId: 'u' } : {} } }));
    getMock.mockResolvedValueOnce({ data: { data: { uploaded: [] } } });
    for (let i = 0; i < 5; i++) getMock.mockResolvedValueOnce({ data: { data: { mergeStatus: 'uploading' } } });
    getMock.mockResolvedValueOnce({ data: { data: { mergeStatus: 'done', mergeResult: { id: 'f', originalName: 'a' } } } });
    const result = useChunkedUpload(1).uploadFile(createFile());
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(result).resolves.toEqual({ id: 'f', originalName: 'a' });
  });

  it('分片请求超时后重试，不当作用户取消', async () => {
    let chunks = 0;
    postMock.mockImplementation((url: string, _body: unknown, config: any) => {
      if (url.endsWith('/init')) return Promise.resolve({ data: { data: { uploadId: 'u' } } });
      if (url === '/files/chunk/u') {
        chunks++;
        if (chunks === 1) return new Promise((_resolve, reject) => config.signal.addEventListener('abort', () => reject({ code: 'ERR_CANCELED' })));
      }
      return Promise.resolve({ data: { data: {} } });
    });
    getMock.mockResolvedValueOnce({ data: { data: { uploaded: [] } } })
      .mockResolvedValue({ data: { data: { mergeStatus: 'done', mergeResult: { id: 'f', originalName: 'a' } } } });
    const result = useChunkedUpload(1).uploadFile(createFile());
    await vi.advanceTimersByTimeAsync(100_000);
    await expect(result).resolves.toEqual({ id: 'f', originalName: 'a' });
    expect(chunks).toBe(2);
  });

  it('失败分片等待其他在途分片结束后才清理会话', async () => {
    let finishSecond!: () => void;
    postMock.mockImplementation((url: string, body: unknown) => {
      if (url.endsWith('/init')) return Promise.resolve({ data: { data: { uploadId: 'u' } } });
      if (url === '/files/chunk/u' && body instanceof FormData) {
        if (body.get('index') === '0') return Promise.reject({ response: { status: 400 } });
        return new Promise(resolve => { finishSecond = () => resolve({ data: {} }); });
      }
      return Promise.resolve({ data: {} });
    });
    getMock.mockResolvedValueOnce({ data: { data: { uploaded: [] } } });
    const result = useChunkedUpload(2).uploadFile(createFile(3 * 1024 * 1024)).catch(e => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(postMock.mock.calls.some(call => call[0] === '/files/chunk/u/abort')).toBe(false);
    finishSecond();
    await result;
    expect(postMock.mock.calls.some(call => call[0] === '/files/chunk/u/abort')).toBe(true);
  });

});
