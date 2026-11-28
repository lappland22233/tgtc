// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B-11 回归：reset() 后在途旧 worker / 旧条目不得污染新会话计数。
 *
 * 事故形态：上传中登出 → 换账号登录 → 立即再上传。旧 worker 仍在跑，
 * 其 finally 里的 activeWorkers-- 会把新会话计数减成负数，ensurePump 的
 * spawn = min(并发, 排队) - activeWorkers 随之超额 spawning；旧条目的终态
 * 回调还会给新会话的成功/失败/取消计数带来幽灵增量。
 */

const deferred: Array<{ reject: (e: unknown) => void; resolve: (v: unknown) => void }> = [];

vi.mock('../composables/useChunkedUpload', () => ({
  useChunkedUpload: () => ({
    uploadId: ref(null),
    uploadFile: () => new Promise((resolve, reject) => {
      deferred.push({ resolve, reject });
    }),
  }),
}));
vi.mock('../api/client', () => ({
  default: { get: vi.fn(async () => ({ data: { code: 0, data: {} } })), post: vi.fn(async () => ({ data: { code: 0, data: {} } })) },
  clearRedirectState: vi.fn(),
}));
vi.mock('../utils/message', () => ({
  default: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { useUploadStore } from './upload';

function makeFile(name: string): File {
  return new File([new Uint8Array(8)], name, { type: 'application/octet-stream' });
}

/** 让排队的微任务与宏任务（调度器/定时器回调）跑完 */
async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('文件夹上传重复项可见性（B-23）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    deferred.length = 0;
    vi.clearAllMocks();
  });

  it('同目录同名重复项被跳过时必须给出提示，不得静默丢弃', async () => {
    const store = useUploadStore();
    const message = (await import('../utils/message')).default as any;

    store.enqueueFolderFiles([
      { file: makeFile('a.txt'), folderId: null, relativePath: 'docs/a.txt' },
      { file: makeFile('a.txt'), folderId: null, relativePath: 'other/a.txt' },
      { file: makeFile('b.txt'), folderId: null, relativePath: 'docs/b.txt' },
    ], []);

    // 两个 a.txt 落到同一目标目录 → 只入队一个，但必须告知用户
    expect(store.entries.filter((e) => e.fileName === 'a.txt')).toHaveLength(1);
    expect(store.entries.filter((e) => e.fileName === 'b.txt')).toHaveLength(1);
    expect(message.warning).toHaveBeenCalledWith(expect.stringContaining('1 个同目录同名重复项已跳过'));
  });

  it('无重复项时不产生提示', async () => {
    const store = useUploadStore();
    const message = (await import('../utils/message')).default as any;

    store.enqueueFolderFiles([
      { file: makeFile('a.txt'), folderId: null },
      { file: makeFile('b.txt'), folderId: null },
    ], []);

    expect(message.warning).not.toHaveBeenCalled();
  });
});

describe('上传队列会话代际（B-11）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    deferred.length = 0;
    vi.clearAllMocks();
  });

  it('reset 后旧上传收尾不得给新会话带来失败/取消增量', async () => {
    const store = useUploadStore();
    store.setStrictSerialUpload(true);

    store.enqueue([makeFile('old.bin')], null, []);
    await flush();
    expect(deferred).toHaveLength(1);
    expect(store.activeCount).toBe(1);

    // 登出清理：旧 worker 仍卡在 uploadFile 上
    store.reset();
    expect(store.activeCount).toBe(0);

    // 新会话立即开始（reset 会把 strictSerial 复位，需重新置位以走分片路径）
    store.setStrictSerialUpload(true);
    store.enqueue([makeFile('new.bin')], null, []);
    await flush();
    expect(deferred).toHaveLength(2);
    expect(store.activeCount).toBe(1);

    // 旧上传此刻才收尾（abort 拒绝）
    deferred[0].reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await flush();

    // 旧条目属于上一代际，不得改动新会话计数
    expect(store.errorCount).toBe(0);
    expect(store.cancelledCount).toBe(0);
    expect(store.successCount).toBe(0);
    expect(store.activeCount).toBe(1);

    // 新会话自己的失败仍正常计数
    deferred[1].reject(new Error('网络失败'));
    await flush();
    expect(store.errorCount + store.cancelledCount).toBe(1);
  });

  it('reset 后旧 worker 退出不得把并发计数减成负数导致超额 spawning', async () => {
    const store = useUploadStore();
    store.setStrictSerialUpload(true);
    store.setFileConcurrency(1);

    store.enqueue([makeFile('old.bin')], null, []);
    await flush();
    store.reset();

    // 新会话排入 3 个文件，并发上限 1
    store.setStrictSerialUpload(true);
    store.setFileConcurrency(1);
    store.enqueue([makeFile('a.bin'), makeFile('b.bin'), makeFile('c.bin')], null, []);
    await flush();
    const spawnedAfterReset = deferred.length - 1;
    expect(spawnedAfterReset).toBe(1);

    // 旧 worker 收尾
    deferred[0].reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await flush();

    // 旧 worker 不得触发额外 spawning，也不得把 activeCount 弄成负数
    expect(store.activeCount).toBeGreaterThanOrEqual(0);
    expect(deferred.length - 1).toBe(1);
    expect(store.activeCount).toBe(1);
  });
});