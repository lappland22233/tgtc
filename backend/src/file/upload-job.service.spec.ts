import 'reflect-metadata';
import { UploadJobService } from './upload-job.service';
import { UploadTask } from '../common/entities/upload-task.entity';

/**
 * B-13：上传任务编排此前零直接测试。
 *
 * 关键不变量：
 * - 同一 jobId 的持久化必须串行（per-job 写链），否则高频 fire-and-forget upsert
 *   并发乱序会让任务状态回退（completed 被后到的 uploading 覆盖）。
 * - 持久化失败不得阻断上传主流程。
 * - 启动恢复只标「陈旧」任务失败，不误伤滚动部署中其他存活实例的在途任务（G3-09）。
 * - 坏 result JSON 不得让整个启动恢复失败（G3-11）。
 */
const user = { id: 'u1', email: 'a@b.c' } as any;

function makeRepo(overrides: Record<string, unknown> = {}) {
  const qb: any = {
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    getMany: jest.fn().mockResolvedValue([]),
    delete: jest.fn(() => qb),
    from: jest.fn(() => qb),
    execute: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  return {
    createQueryBuilder: jest.fn(() => qb),
    upsert: jest.fn().mockResolvedValue(undefined),
    save: jest.fn(async (x: any) => x),
    qb,
    ...overrides,
  } as any;
}

function makeService(repo = makeRepo()) {
  const service = new UploadJobService(repo);
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, repo };
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('UploadJobService（B-13）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('createJob 写入内存缓存并异步持久化', async () => {
    const { service, repo } = makeService();
    const job = service.createJob(user, 'a.txt');
    expect(job.status).toBe('pending');
    expect(job.progress).toBe(0);
    expect(service.getJob(job.jobId)).toBe(job);
    await flush();
    expect(repo.upsert).toHaveBeenCalledTimes(1);
  });

  it('fileCount > 1 时 filename 汇总为「N 个文件」', () => {
    const { service } = makeService();
    expect(service.createJob(user, 'a.txt', 3).filename).toBe('3 个文件');
    expect(service.createJob(user, 'a.txt', 1).filename).toBe('a.txt');
  });

  it('getJob 未知 id 返回 undefined；updateJob 未知 id 不抛也不落库', async () => {
    const { service, repo } = makeService();
    expect(service.getJob('nope')).toBeUndefined();
    expect(() => service.updateJob('nope', { progress: 50 })).not.toThrow();
    await flush();
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('updateJob 刷新 updatedAt 并合并字段', async () => {
    const { service } = makeService();
    const job = service.createJob(user, 'a.txt');
    const before = job.updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 2));
    service.updateJob(job.jobId, { status: 'uploading', progress: 40 });
    expect(job.status).toBe('uploading');
    expect(job.progress).toBe(40);
    expect(job.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('同一 jobId 的持久化严格串行：前一次未落库时后一次不得发起', async () => {
    const resolvers: Array<() => void> = [];
    const repo = makeRepo({
      upsert: jest.fn().mockImplementation(() => new Promise<void>((resolve) => {
        resolvers.push(resolve);
      })),
    });
    const { service } = makeService(repo);

    const job = service.createJob(user, 'a.txt');
    service.updateJob(job.jobId, { progress: 50 });
    service.updateJob(job.jobId, { status: 'completed', progress: 100 });
    await flush();

    // 三次更新只允许一次在飞，其余排在写链上
    expect(repo.upsert).toHaveBeenCalledTimes(1);
    resolvers[0]();
    await flush();
    expect(repo.upsert).toHaveBeenCalledTimes(2);
    resolvers[1]();
    await flush();
    expect(repo.upsert).toHaveBeenCalledTimes(3);
    // 最后一次落库必须是终态，不得被乱序覆盖回 uploading
    expect(repo.upsert.mock.calls[2][0]).toEqual(expect.objectContaining({
      status: 'completed', progress: 100,
    }));
    resolvers[2]();
    await flush();
  });

  it('持久化失败不阻断主流程，仅告警', async () => {
    const repo = makeRepo({ upsert: jest.fn().mockRejectedValue(new Error('db down')) });
    const { service } = makeService(repo);
    const job = service.createJob(user, 'a.txt');
    expect(() => service.updateJob(job.jobId, { progress: 10 })).not.toThrow();
    await flush();
    expect((service as any).logger.warn).toHaveBeenCalled();
    expect(service.getJob(job.jobId)!.progress).toBe(10);
  });

  it('写链空闲后清理引用，避免 Map 泄漏', async () => {
    const { service } = makeService();
    const job = service.createJob(user, 'a.txt');
    await flush();
    expect((service as any).writeChains.has(job.jobId)).toBe(false);
  });

  it('cleanup 按 SQL 条件直删并同步清理内存与写链', async () => {
    const { service, repo } = makeService();
    const job = service.createJob(user, 'a.txt');
    service.updateJob(job.jobId, { status: 'completed' });
    await flush();
    // 把 updatedAt 推到 31 分钟前
    job.updatedAt = new Date(Date.now() - 31 * 60 * 1000);
    repo.qb.execute.mockResolvedValue({ affected: 1 });

    await service.cleanup();

    expect(repo.createQueryBuilder).toHaveBeenCalled();
    expect(service.getJob(job.jobId)).toBeUndefined();
    expect((service as any).writeChains.has(job.jobId)).toBe(false);
  });

  it('cleanup 对卡住的 pending/uploading 用 60 分钟阈值', async () => {
    const { service } = makeService();
    const job = service.createJob(user, 'a.txt');
    await flush();
    job.updatedAt = new Date(Date.now() - 45 * 60 * 1000);
    await service.cleanup();
    // 45 分钟 < 60 分钟阈值，仍在途的任务不得被清掉
    expect(service.getJob(job.jobId)).toBeDefined();
  });

  it('onModuleInit 只标陈旧任务失败，短时内在途任务保留（G3-09）', async () => {
    const stale = { jobId: 'j-stale', status: 'uploading', updatedAt: new Date(0) };
    const repo = makeRepo();
    repo.qb.getMany
      .mockResolvedValueOnce([stale])   // 陈旧查询
      .mockResolvedValueOnce([]);       // 近期任务查询
    const { service } = makeService(repo);

    await service.onModuleInit();

    expect(stale.status).toBe('failed');
    expect(repo.save).toHaveBeenCalledWith(stale);
    service.onModuleDestroy();
  });

  it('onModuleInit 恢复近期任务；坏 result JSON 被忽略而不中断（G3-11）', async () => {
    const repo = makeRepo();
    repo.qb.getMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { jobId: 'j-ok', userId: 'u1', filename: 'a', status: 'completed', progress: 100, result: '{"id":"f1"}', error: null, createdAt: new Date(), updatedAt: new Date() },
        { jobId: 'j-bad', userId: 'u1', filename: 'b', status: 'failed', progress: 0, result: '{not-json', error: 'x', createdAt: new Date(), updatedAt: new Date() },
      ]);
    const { service } = makeService(repo);

    await service.onModuleInit();

    expect(service.getJob('j-ok')!.result).toEqual({ id: 'f1' });
    expect(service.getJob('j-bad')!.result).toBeUndefined();
    service.onModuleDestroy();
  });

  it('onModuleDestroy 清理定时器且幂等', () => {
    const { service } = makeService();
    (service as any).cleanupTimer = setInterval(() => {}, 1000);
    service.onModuleDestroy();
    expect((service as any).cleanupTimer).toBeNull();
    expect(() => service.onModuleDestroy()).not.toThrow();
  });

  it('upsert 以 jobId 为冲突键，result 序列化、error 空值归 null', async () => {
    const { service, repo } = makeService();
    const job = service.createJob(user, 'a.txt');
    service.updateJob(job.jobId, { status: 'completed', result: { id: 'f1' } as any });
    await flush();
    const last = repo.upsert.mock.calls.at(-1)!;
    expect(last[1]).toEqual(['jobId']);
    expect(last[0].result).toBe(JSON.stringify({ id: 'f1' }));
    expect(last[0].error).toBeNull();
    expect(last[0]).not.toBeInstanceOf(UploadTask);
  });
});