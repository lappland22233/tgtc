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
    await new Promise(resolve => setImmediate(resolve));
    expect(await readFile(path.join(cwd, 'tmp', 'Cache', fileId))).toEqual(Buffer.from('abcdef'));
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

  it('never writes to disk, never builds a session, never computes capacity or evicts', async () => {
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
    expect(await listCacheDir()).toEqual([]);
    expect((service as any).buildSessions.size).toBe(0);
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
    expect(await listCacheDir()).toEqual([]);
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

  it('skips cache warm-up: cacheFileFromPath resolves without creating any cache file', async () => {
    const sourcePath = path.join(cwd, 'source.bin');
    await writeFile(sourcePath, Buffer.from('hello'));

    await service.cacheFileFromPath(fileId, sourcePath, 5);

    expect(await listCacheDir()).toEqual([]);
    expect(service.getCachedPath(fileId)).toBeNull();
  });
});
