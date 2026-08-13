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
    await rm(cwd, { recursive: true, force: true });
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
    // 等待构造期 reloadConfig 生效（与现有 harness 一致）
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true });
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

  it('destroys the upstream when the client disconnects immediately', async () => {
    const upstream = new PassThrough();
    const { stream } = await service.getOrCacheStream(fileId, 6, async () => ({
      stream: upstream,
      info: { file_size: 6 },
    }));
    stream.destroy();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(upstream.destroyed).toBe(true);
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

  it('C-04：spool 完成后磁盘上不残留正式缓存（不发布），仅临时 spool 清理后空目录', async () => {
    const upstream = new PassThrough();
    const { stream } = await service.getOrCacheStream(fileId, 4, async () => ({
      stream: upstream,
      info: { file_size: 4 },
    }));
    const contentPromise = readStream(stream);
    upstream.end(Buffer.from('data'));
    await expect(contentPromise).resolves.toEqual(Buffer.from('data'));

    // 消费者关闭后 teardown 异步清理 spool 文件
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await listCacheDir()).toEqual([]);
    expect(service.getCachedPath(fileId)).toBeNull();
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
