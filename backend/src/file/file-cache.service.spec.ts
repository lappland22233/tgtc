import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { PassThrough, Readable } from 'stream';
import { FileCacheService } from './file-cache.service';

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Windows 上删除临时目录时，若残留打开句柄（spool 流 / 构建会话）未释放，
 * rm 会抛 EBUSY/EPERM。做有限次退避重试消除测试间的时序抖动。
 */
async function rmDirSafe(dir: string, retries = 5): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (i >= retries || (err?.code !== 'EBUSY' && err?.code !== 'EPERM')) throw err;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

/** 等待服务实例的 spool/build 会话全部收尾（避免残留会话污染下一测试的串行化占位） */
async function waitSessionsSettled(svc: any): Promise<void> {
  const sessions = [
    ...(svc.spoolSessions?.values?.() ?? []),
    ...(svc.buildSessions?.values?.() ?? []),
    ...(svc.passthroughSessions?.values?.() ?? []),
  ];
  await Promise.allSettled(sessions.map((s: any) => s?.completion?.catch?.(() => {})));
}

describe('FileCacheService realtime build session', () => {
  let cwd: string;
  let service: FileCacheService;
  const fileId = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'file-cache-test-'));
    jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    service = new FileCacheService({ get: jest.fn((_key: string, fallback: string) => fallback) } as any);
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await waitSessionsSettled(service);
    await rmDirSafe(cwd);
  });

  it('streams cold bytes immediately and atomically publishes the cache', async () => {
    const upstream = new PassThrough();
    const fetchFn = jest.fn(async () => ({ stream: upstream, info: { file_size: 6 } }));
    const resultPromise = service.getOrCacheStream(fileId, 6, fetchFn);

    upstream.write(Buffer.from('abc'));
    const { stream } = await resultPromise;
    const contentPromise = readStream(stream);
    upstream.end(Buffer.from('def'));

    await expect(contentPromise).resolves.toEqual(Buffer.from('abcdef'));
    // rename 发布是异步的（Windows 下文件句柄释放存在时序），轮询等待正式缓存出现
    const cachePath = path.join(cwd, 'tmp', 'Cache', fileId);
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        const data = await readFile(cachePath);
        expect(data).toEqual(Buffer.from('abcdef'));
        break;
      } catch {
        if (Date.now() > deadline) throw new Error(`缓存文件未在 2s 内发布: ${cachePath}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  });

  it('shares one upstream build across concurrent consumers', async () => {
    const upstream = new PassThrough();
    const fetchFn = jest.fn(async () => ({ stream: upstream, info: { file_size: 4 } }));
    const first = service.getOrCacheStream(fileId, 4, fetchFn);
    const second = service.getOrCacheStream(fileId, 4, fetchFn);

    upstream.end(Buffer.from('data'));
    const [a, b] = await Promise.all([first, second]);
    await expect(Promise.all([readStream(a.stream), readStream(b.stream)])).resolves.toEqual([
      Buffer.from('data'),
      Buffer.from('data'),
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('removes a partial cache when the upstream fails', async () => {
    const upstream = new PassThrough();
    const resultPromise = service.getOrCacheStream(fileId, 6, async () => ({
      stream: upstream,
      info: { file_size: 6 },
    }));
    upstream.write(Buffer.from('abc'));
    const { stream } = await resultPromise;
    const contentPromise = readStream(stream);
    upstream.destroy(new Error('upstream failed'));

    await expect(contentPromise).rejects.toThrow('upstream failed');
    await new Promise(resolve => setImmediate(resolve));
    expect(service.getCachedPath(fileId)).toBeNull();
  });

  it('aborts a half-open upstream after the idle deadline', async () => {
    (service as any).buildIdleTimeoutMs = 20;
    (service as any).buildTotalTimeoutMs = 1000;
    const upstream = new PassThrough();
    const resultPromise = service.getOrCacheStream(fileId, 6, async () => ({
      stream: upstream,
      info: { file_size: 6 },
    }));

    upstream.write(Buffer.from('abc'));
    const { stream } = await resultPromise;
    await expect(readStream(stream)).rejects.toThrow('缓存构建空闲超时');
    const session = (service as any).buildSessions.get(fileId);
    await session?.completion.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    expect(upstream.destroyed).toBe(true);
    expect(service.getCachedPath(fileId)).toBeNull();
    expect((service as any).buildSessions.size).toBe(0);
  });

  it('actively aborts a build before invalidating its files', async () => {
    const upstream = new PassThrough();
    const resultPromise = service.getOrCacheStream(fileId, 6, async () => ({
      stream: upstream,
      info: { file_size: 6 },
    }));
    upstream.write(Buffer.from('abc'));
    const { stream } = await resultPromise;
    const contentPromise = readStream(stream);
    const contentExpectation = expect(contentPromise).rejects.toThrow('缓存构建已失效');

    await service.invalidate(fileId);
    await contentExpectation;
    const deadline = Date.now() + 200;
    while (!upstream.destroyed && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(upstream.destroyed).toBe(true);
    expect((service as any).buildSessions.size).toBe(0);
  });
});

describe('FileCacheService no-cache mode', () => {
  let cwd: string;
  let service: FileCacheService;
  const fileId = '22222222-2222-4222-8222-222222222222';

  const createNoCacheService = () =>
    new FileCacheService({
      get: jest.fn((key: string, fallback: string) =>
        key === 'FILE_CACHE_NO_CACHE_MODE' ? 'true' : fallback,
      ),
    } as any);

  const nextTick = () => new Promise(resolve => setImmediate(resolve));
  const listCacheDir = () => readdir(path.join(cwd, 'tmp', 'Cache')).catch(() => [] as string[]);
  /** 轮询等待目录收敛到期望状态（spool 异步清理，避免时序抖动） */
  const waitForDir = async (expectEmpty: boolean, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const files = await listCacheDir();
      const ok = expectEmpty ? files.length === 0 : files.length > 0;
      if (ok) return;
      if (Date.now() > deadline) throw new Error(`缓存目录未在 ${timeoutMs}ms 内收敛: ${JSON.stringify(await listCacheDir())}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'file-cache-nocache-test-'));
    jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    service = createNoCacheService();
    // 测试缩短宽限期；生产默认值固定为 120 秒。
    (service as any).sessionCoordinator.spoolConsumerGracePeriodMs = 20;
    // 等待构造期 reloadConfig 生效（与现有 harness 一致）
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  afterEach(async () => {
    // 测试可能使用 fake timers；先恢复真实定时器，确保收尾清理不会被挂起。
    jest.useRealTimers();
    // 测试结束时主动清理宽限中的 spool，避免等待 120 秒并污染下一用例。
    for (const session of [...(service.spoolSessions?.values?.() ?? [])]) {
      await (service as any).sessionCoordinator.teardownSpoolSession(session);
    }
    jest.restoreAllMocks();
    // 等待本测试的 spool/build 会话收尾（含被中止的失败会话），避免残留会话
    // 污染下一测试（G4-02 per-fileId 串行化占位）或在 rm 时触发 Windows EBUSY。
    await waitSessionsSettled(service);
    await rmDirSafe(cwd);
  });

  it('passthrough returns full bytes with fetchFn called once and fromCache === false', async () => {
    const upstream = new PassThrough();
    const fetchFn = jest.fn(async () => ({ stream: upstream, info: { file_size: 6 } }));
    const resultPromise = service.getOrCacheStream(fileId, 6, fetchFn);

    upstream.write(Buffer.from('abc'));
    const { stream, fromCache } = await resultPromise;
    expect(fromCache).toBe(false);
    const contentPromise = readStream(stream);
    upstream.end(Buffer.from('def'));

    await expect(contentPromise).resolves.toEqual(Buffer.from('abcdef'));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('no-cache tee: 并发消费者共享一个上游连接（fetchFn 只调用一次）', async () => {
    const upstream = new PassThrough();
    const fetchFn = jest.fn(async () => ({ stream: upstream, info: { file_size: 6 } }));
    const first = service.getOrCacheStream(fileId, 6, fetchFn);
    const second = service.getOrCacheStream(fileId, 6, fetchFn);

    upstream.write(Buffer.from('abc'));
    const [a, b] = await Promise.all([first, second]);
    const aRead = readStream(a.stream);
    const bRead = readStream(b.stream);
    upstream.end(Buffer.from('def'));

    await expect(aRead).resolves.toEqual(Buffer.from('abcdef'));
    await expect(bRead).resolves.toEqual(Buffer.from('abcdef'));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('propagates a spool upstream failure without an unhandled output error', async () => {
    const upstream = new PassThrough();
    const { stream } = await service.getOrCacheStream(fileId, 6, async () => ({
      stream: upstream,
      info: { file_size: 6 },
    }));
    const contentPromise = readStream(stream);
    upstream.write(Buffer.from('abc'));
    upstream.once('error', () => {});
    upstream.destroy(new Error('spool upstream failed'));

    await expect(contentPromise).rejects.toThrow('spool upstream failed');
    const session = (service as any).spoolSessions.get(fileId);
    await session?.completion?.catch(() => {});
    await waitForDir(true);
  });

  it('spool mode: 不发布正式缓存、不建 build 会话、不触发 LRU/容量计算', async () => {
    const evictSpy = jest.spyOn(service as any, 'evictLRU');
    const sizeSpy = jest.spyOn(service as any, 'getTotalCacheSize');

    const upstream = new PassThrough();
    const { stream } = await service.getOrCacheStream(fileId, 4, async () => ({
      stream: upstream,
      info: { file_size: 4 },
    }));
    const contentPromise = readStream(stream);
    upstream.end(Buffer.from('data'));
    await expect(contentPromise).resolves.toEqual(Buffer.from('data'));

    await nextTick();
    // C-04 修复：spool 允许有界临时文件，但绝不发布正式缓存、不触发 LRU/容量计算；
    // 消费完成后 spool 异步清理，目录最终收敛为空。
    await waitForDir(true);
    expect((service as any).buildSessions.size).toBe(0);
    expect((service as any).spoolSessions.size).toBe(0);
    expect(service.getCachedPath(fileId)).toBeNull();
    expect(evictSpy).not.toHaveBeenCalled();
    expect(sizeSpy).not.toHaveBeenCalled();
  });

  it('aborts a half-way default-mode session and streams fresh bytes independently', async () => {
    const defaultService = new FileCacheService({
      get: jest.fn((_key: string, fallback: string) => fallback),
    } as any);
    await new Promise(resolve => setTimeout(resolve, 10));

    // 默认模式起半程会话，写入部分字节
    const oldUpstream = new PassThrough();
    const oldResult = await (async () => {
      const p = defaultService.getOrCacheStream(fileId, 6, async () => ({
        stream: oldUpstream,
        info: { file_size: 6 },
      }));
      oldUpstream.write(Buffer.from('abc'));
      return p;
    })();
    const followerPromise = readStream(oldResult.stream);
    // 提前挂载断言：旧会话中止时 follower 会 reject，避免被判定为 unhandled rejection
    const followerExpectation = expect(followerPromise).rejects.toThrow('无缓存模式已启用，缓存构建已中止');

    // 翻转无缓存模式后再请求：旧会话被中止，新请求直通新上游
    (defaultService as any).noCacheMode = true;
    const newUpstream = new PassThrough();
    const fetchFn = jest.fn(async () => ({ stream: newUpstream, info: { file_size: 6 } }));
    const newPromise = defaultService.getOrCacheStream(fileId, 6, fetchFn);
    newUpstream.write(Buffer.from('xyz'));
    const { stream: direct, fromCache } = await newPromise;
    expect(fromCache).toBe(false);
    const directPromise = readStream(direct);
    newUpstream.end(Buffer.from('uvw'));

    await expect(directPromise).resolves.toEqual(Buffer.from('xyzuvw'));
    await followerExpectation;
    expect(oldUpstream.destroyed).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await nextTick();
    expect((defaultService as any).buildSessions.size).toBe(0);
    for (const session of [...(defaultService.spoolSessions?.values?.() ?? [])]) {
      await (defaultService as any).sessionCoordinator.teardownSpoolSession(session);
    }
    await waitForDir(true);
  });

  it('flips to no-cache on config.changed and config.batch-changed, aborting active sessions', async () => {
    // config.changed：可变配置源模拟管理后台写入
    let noCacheConfig = 'false';
    const svc = new FileCacheService({
      get: jest.fn((key: string, fallback: string) =>
        key === 'FILE_CACHE_NO_CACHE_MODE' ? noCacheConfig : fallback,
      ),
    } as any);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(svc.isNoCacheMode()).toBe(false);

    const upstream = new PassThrough();
    const resultPromise = svc.getOrCacheStream(fileId, 6, async () => ({
      stream: upstream,
      info: { file_size: 6 },
    }));
    upstream.write(Buffer.from('abc'));
    const { stream } = await resultPromise;
    const contentPromise = readStream(stream);
    // 提前挂载断言：配置翻转触发的中止会使 follower reject
    const contentExpectation = expect(contentPromise).rejects.toThrow('无缓存模式已启用，缓存构建已中止');
    const session = (svc as any).buildSessions.get(fileId);

    noCacheConfig = 'true';
    await svc.onConfigChanged({ key: 'FILE_CACHE_NO_CACHE_MODE', value: 'true' });
    expect(svc.isNoCacheMode()).toBe(true);
    expect(upstream.destroyed).toBe(true);
    await contentExpectation;
    await session?.completion.catch(() => {});
    await nextTick();
    expect((svc as any).buildSessions.size).toBe(0);

    // config.batch-changed：数组 payload 中任一键属于缓存配置即触发 reload
    let batchNoCacheConfig = 'false';
    const svc2 = new FileCacheService({
      get: jest.fn((key: string, fallback: string) =>
        key === 'FILE_CACHE_NO_CACHE_MODE' ? batchNoCacheConfig : fallback,
      ),
    } as any);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(svc2.isNoCacheMode()).toBe(false);

    batchNoCacheConfig = 'true';
    await svc2.onBatchConfigChanged([
      { key: 'other_key', value: '1' },
      { key: 'FILE_CACHE_NO_CACHE_MODE', value: 'true' },
    ]);
    expect(svc2.isNoCacheMode()).toBe(true);
  });

  it('客户端立即断开时在宽限期内保留 spool 上游', async () => {
    const upstream = new PassThrough();
    const { stream } = await service.getOrCacheStream(fileId, 6, async () => ({
      stream: upstream,
      info: { file_size: 6 },
    }));
    stream.destroy();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(upstream.destroyed).toBe(false);
    expect((service as any).spoolSessions.has(fileId)).toBe(true);
  });

  it('C-04：迟到消费者从 offset 0 逐字节重放，不缺失已前进前缀', async () => {
    const upstream = new PassThrough();
    const fetchFn = jest.fn(async () => ({ stream: upstream, info: { file_size: 6 } }));

    // 首个消费者先加入，上游写入前缀后创建迟到消费者
    const firstPromise = service.getOrCacheStream(fileId, 6, fetchFn);
    upstream.write(Buffer.from('abc'));
    const first = await firstPromise;
    const firstRead = readStream(first.stream);

    const secondPromise = service.getOrCacheStream(fileId, 6, fetchFn);
    const second = await secondPromise;
    const secondRead = readStream(second.stream);

    upstream.end(Buffer.from('def'));

    await expect(firstRead).resolves.toEqual(Buffer.from('abcdef'));
    await expect(secondRead).resolves.toEqual(Buffer.from('abcdef'));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('C-04：spool Range follower 返回指定区间，并在宽限期内重连复用会话', async () => {
    (service as any).sessionCoordinator.spoolConsumerGracePeriodMs = 40;
    const upstream = new PassThrough();
    const fetchFn = jest.fn(async () => ({ stream: upstream, info: { file_size: 6 } }));
    const first = await service.getOrCacheRangeStream(fileId, 6, 1, 3, fetchFn);
    expect(first).not.toBeNull();
    upstream.write(Buffer.from('abcdef'));
    await expect(readStream(first!)).resolves.toEqual(Buffer.from('bcd'));

    const second = await service.getOrCacheRangeStream(fileId, 6, 4, 5, fetchFn);
    expect(second).not.toBeNull();
    await expect(readStream(second!)).resolves.toEqual(Buffer.from('ef'));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect((service as any).spoolSessions.size).toBe(0);
    expect(await listCacheDir()).toEqual([]);
  });

  it('C-04：spool 完成后磁盘上不残留正式缓存（不发布），宽限期后清理 spool', async () => {
    (service as any).sessionCoordinator.spoolConsumerGracePeriodMs = 20;
    const upstream = new PassThrough();
    const { stream } = await service.getOrCacheStream(fileId, 4, async () => ({
      stream: upstream,
      info: { file_size: 4 },
    }));
    const contentPromise = readStream(stream);
    upstream.end(Buffer.from('data'));
    await expect(contentPromise).resolves.toEqual(Buffer.from('data'));

    // 消费者关闭后 teardown 异步清理 spool
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await listCacheDir()).toEqual([]);
    expect(service.getCachedPath(fileId)).toBeNull();
  });

  it('spool 最后一个消费者断开后 119 秒不清理、120 秒无人时清理', async () => {
    jest.useFakeTimers();
    (service as any).sessionCoordinator.spoolConsumerGracePeriodMs = 120_000;
    const upstream = new PassThrough();
    const { stream } = await service.getOrCacheStream(fileId, 4, async () => ({
      stream: upstream,
      info: { file_size: 4 },
    }));
    const contentPromise = readStream(stream);
    upstream.end(Buffer.from('data'));
    await expect(contentPromise).resolves.toEqual(Buffer.from('data'));
    const session = (service as any).spoolSessions.get(fileId);
    expect(session.consumerCount).toBe(0);

    jest.advanceTimersByTime(119_000);
    await Promise.resolve();
    expect((service as any).spoolSessions.get(fileId)).toBe(session);

    jest.advanceTimersByTime(1_000);
    await jest.runAllTimersAsync();
    await session.completion;
    expect((service as any).spoolSessions.has(fileId)).toBe(false);
    jest.useRealTimers();
    await waitForDir(true);
  });

  it('重连取消旧 timer，并在再次断开时从零重置宽限 timer', async () => {
    (service as any).sessionCoordinator.spoolConsumerGracePeriodMs = 120_000;
    const upstream = new PassThrough();
    const fetchFn = jest.fn(async () => ({ stream: upstream, info: { file_size: 6 } }));
    const first = await service.getOrCacheRangeStream(fileId, 6, 0, 1, fetchFn);
    upstream.end(Buffer.from('abcdef'));
    await expect(readStream(first!)).resolves.toEqual(Buffer.from('ab'));
    const session = (service as any).spoolSessions.get(fileId);
    clearTimeout(session.teardownTimer);
    session.teardownTimer = undefined;

    jest.useFakeTimers();
    const coordinator = (service as any).sessionCoordinator;
    const disconnected = coordinator.createSpoolFollowerStream(session, 0, 1);
    disconnected.emit('close');
    const oldTimer = session.teardownTimer;
    expect(oldTimer).toBeDefined();
    jest.advanceTimersByTime(60_000);

    const reconnected = coordinator.createSpoolFollowerStream(session, 2, 3);
    expect(session.teardownTimer).toBeUndefined();
    expect((service as any).spoolSessions.get(fileId)).toBe(session);
    reconnected.emit('close');
    expect(session.teardownTimer).toBeDefined();
    expect(session.teardownTimer).not.toBe(oldTimer);

    // 重连取消旧 timer；再次断开后从零开始计时。
    jest.advanceTimersByTime(119_999);
    expect((service as any).spoolSessions.get(fileId)).toBe(session);
    jest.advanceTimersByTime(1);
    await jest.runAllTimersAsync();
    expect((service as any).spoolSessions.has(fileId)).toBe(false);
  });

  it('重复 close 不会重复减少消费者计数', async () => {
    (service as any).sessionCoordinator.spoolConsumerGracePeriodMs = 120_000;
    const upstream = new PassThrough();
    const { stream } = await service.getOrCacheStream(fileId, 4, async () => ({
      stream: upstream,
      info: { file_size: 4 },
    }));
    const session = (service as any).spoolSessions.get(fileId);
    upstream.end(Buffer.from('data'));
    await expect(readStream(stream)).resolves.toEqual(Buffer.from('data'));
    stream.emit('close');
    stream.emit('close');
    expect(session.consumerCount).toBe(0);
  });

  it('上游完成后宽限期内仍可按 Range 读取同一 spool', async () => {
    (service as any).sessionCoordinator.spoolConsumerGracePeriodMs = 120_000;
    const upstream = new PassThrough();
    const fetchFn = jest.fn(async () => ({ stream: upstream, info: { file_size: 6 } }));
    const first = await service.getOrCacheStream(fileId, 6, fetchFn);
    upstream.end(Buffer.from('abcdef'));
    await expect(readStream(first.stream)).resolves.toEqual(Buffer.from('abcdef'));

    const range = await service.getOrCacheRangeStream(fileId, 6, 2, 4, fetchFn);
    await expect(readStream(range!)).resolves.toEqual(Buffer.from('cde'));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((service as any).spoolSessions.has(fileId)).toBe(true);
  });

  it('shutdown 立即清理宽限期中的 spool 会话和文件', async () => {
    (service as any).sessionCoordinator.spoolConsumerGracePeriodMs = 120_000;
    const upstream = new PassThrough();
    const { stream } = await service.getOrCacheStream(fileId, 4, async () => ({
      stream: upstream,
      info: { file_size: 4 },
    }));
    upstream.end(Buffer.from('data'));
    await expect(readStream(stream)).resolves.toEqual(Buffer.from('data'));
    expect((service as any).spoolSessions.has(fileId)).toBe(true);

    await service.onApplicationShutdown();
    expect((service as any).spoolSessions.has(fileId)).toBe(false);
    expect(await listCacheDir()).toEqual([]);
  });

  it('H-06：冷回源并发预算——达到上限时拒绝新建并抛 503', async () => {
    // 将预算压到 1：第一个回源占满预算，第二个被拒绝
    (service as any).maxConcurrentUpstreams = 1;
    (service as any).activeUpstreams = 1;
    await expect(
      service.getNoCacheStream(fileId, 4, async () => ({
        stream: new PassThrough(),
        info: { file_size: 4 },
      })),
    ).rejects.toThrow(/繁忙|retry|稍后|重试/i);
  });

  it('H-09：onApplicationShutdown 中止构建会话并释放 spool', async () => {
    const upstream = new PassThrough();
    // 启动一个 build 会话（占用上游计数）
    const fetchFn = jest.fn(async () => ({ stream: upstream, info: { file_size: 6 } }));
    void service.getOrCacheStream(fileId, 6, fetchFn);
    await new Promise(resolve => setTimeout(resolve, 10));

    await service.onApplicationShutdown();
    // 关闭后拒绝新建（canStartUpstream=false）
    (service as any).activeUpstreams = 0;
    await expect(
      service.getOrCacheStream(fileId, 4, async () => ({
        stream: new PassThrough(),
        info: { file_size: 4 },
      })),
    ).rejects.toThrow(/繁忙|retry|稍后|重试/i);
  });

  it('skips cache warm-up: cacheFileFromPath resolves without creating any cache file', async () => {
    const sourcePath = path.join(cwd, 'source.bin');
    await writeFile(sourcePath, Buffer.from('hello'));

    await service.cacheFileFromPath(fileId, sourcePath, 5);

    expect(await listCacheDir()).toEqual([]);
    expect(service.getCachedPath(fileId)).toBeNull();
  });
});
