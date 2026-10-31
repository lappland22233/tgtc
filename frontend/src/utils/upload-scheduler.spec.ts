import { afterEach, describe, expect, it } from 'vitest';
import { uploadScheduler } from './upload-scheduler';

describe('upload scheduler', () => {
  afterEach(() => uploadScheduler.setConcurrency(4));

  it('cancels a queued request without consuming a slot', async () => {
    uploadScheduler.setConcurrency(1);
    await uploadScheduler.acquire();
    const controller = new AbortController();
    const waiting = uploadScheduler.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow('上传已取消');
    expect(uploadScheduler.getQueueLength()).toBe(0);
    uploadScheduler.release();
    expect(uploadScheduler.getActiveCount()).toBe(0);
  });

  it('does not grant queued requests until a reduced limit has room', async () => {
    uploadScheduler.setConcurrency(3);
    await Promise.all([uploadScheduler.acquire(), uploadScheduler.acquire(), uploadScheduler.acquire()]);
    uploadScheduler.setConcurrency(1);
    let granted = false;
    const waiting = uploadScheduler.acquire().then(() => { granted = true; });
    uploadScheduler.setConcurrency(2);
    await Promise.resolve();
    expect(granted).toBe(false);
    uploadScheduler.release();
    await Promise.resolve();
    expect(granted).toBe(false);
    uploadScheduler.release();
    await waiting;
    expect(uploadScheduler.getActiveCount()).toBe(2);
    uploadScheduler.release();
    uploadScheduler.release();
  });
});
