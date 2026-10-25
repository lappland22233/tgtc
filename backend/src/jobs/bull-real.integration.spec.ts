import Bull from 'bull';
import { randomUUID } from 'crypto';

const describeRedis = process.env.REDIS_IT === '1' ? describe : describe.skip;

// UUID override 涉及 Bull 的入队路径，必须通过真实 Redis 任务生命周期验证兼容性。
describeRedis('Bull / patched UUID / real Redis', () => {
  let queue: Bull.Queue;
  let worker: Promise<void> | undefined;
  beforeAll(async () => {
    queue = new Bull(`security-regression-${randomUUID()}`, {
      prefix: 'tgtc-ci',
      redis: { host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined, db: Number(process.env.REDIS_TEST_DB || 15),
        maxRetriesPerRequest: 1 },
    });
    await queue.isReady();
  });
  afterAll(async () => {
    if (queue) {
      try { await queue.obliterate({ force: true }); } finally { await queue.close(); }
      await worker;
    }
  });

  it('enqueues distinct jobs and completes each payload through the worker', async () => {
    // process() 的 Promise 代表 worker 生命周期，必须先入队、完成后再 close/await。
    worker = queue.process('regression', 2, async (job) => ({ value: job.data.value * 2 }));
    const jobs = await Promise.all(Array.from({ length: 8 }, (_, value) => queue.add('regression', { value })));
    expect(new Set(jobs.map((job) => job.id)).size).toBe(8);
    const results = await Promise.all(jobs.map((job) => job.finished()));
    expect(results).toEqual(Array.from({ length: 8 }, (_, value) => ({ value: value * 2 })));
    expect(await queue.getCompletedCount()).toBe(8);
  }, 15000);
});
