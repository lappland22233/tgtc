import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { FileCacheService } from './file-cache.service';
import { ConfigCacheService } from '../common/services/config-cache.service';

const FILE_ID = '11111111-1111-4111-8111-111111111111';

describe('FileCacheService safe stream opening', () => {
  let tempDir: string;
  let service: FileCacheService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-cache-test-'));
    const configCache = {
      get: jest.fn((_key: string, fallback: string) => Promise.resolve(fallback)),
    } as unknown as ConfigCacheService;
    service = new FileCacheService(configCache);
    (service as unknown as { cacheDir: string }).cacheDir = tempDir;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('缓存文件已被删除时应按未命中返回 null', async () => {
    await expect(service.openCachedReadStream(FILE_ID, 4)).resolves.toBeNull();
  });

  it('应从已打开并校验的句柄返回完整缓存流', async () => {
    await fs.writeFile(path.join(tempDir, FILE_ID), Buffer.from('data'));
    const stream = await service.openCachedReadStream(FILE_ID, 4);
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('data');
  });

  it('应从同一已打开句柄返回 Range 流', async () => {
    await fs.writeFile(path.join(tempDir, FILE_ID), Buffer.from('abcdef'));
    const stream = await service.openCachedReadStream(FILE_ID, 6, { start: 1, end: 3 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('bcd');
  });

  it('缓存大小不一致时应删除失效文件并返回 null', async () => {
    const cachePath = path.join(tempDir, FILE_ID);
    await fs.writeFile(cachePath, Buffer.from('bad'));
    await expect(service.openCachedReadStream(FILE_ID, 4)).resolves.toBeNull();
    await expect(fs.stat(cachePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('缓存未命中时应在源流结束和缓存发布前把首块交给客户端', async () => {
    const source = new PassThrough();
    const pending = service.getOrCacheStream(FILE_ID, 10, async () => ({
      stream: source,
      info: { file_id: 'tg-file', file_path: 'documents/file.bin', file_size: 10 },
    }));
    const result = await pending;
    const received: Buffer[] = [];
    result.stream.on('data', (chunk) => received.push(Buffer.from(chunk)));

    source.write(Buffer.from('first'));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(Buffer.concat(received).toString()).toBe('first');
    await expect(fs.stat(path.join(tempDir, FILE_ID))).rejects.toMatchObject({ code: 'ENOENT' });

    source.end(Buffer.from('last!'));
    await new Promise<void>((resolve, reject) => {
      result.stream.once('end', resolve);
      result.stream.once('error', reject);
      result.stream.resume();
    });
    const inflight = (service as unknown as { inflight: Map<string, { completion: Promise<void> }> }).inflight.get(FILE_ID);
    await expect(inflight?.completion).resolves.toBeUndefined();
    await expect(fs.readFile(path.join(tempDir, FILE_ID), 'utf8')).resolves.toBe('firstlast!');
  });

  it('客户端中断后仍应继续完成缓存预热', async () => {
    const source = new PassThrough();
    const { stream } = await service.getOrCacheStream(FILE_ID, 10, async () => ({
      stream: source,
      info: { file_id: 'tg-file', file_path: 'documents/file.bin', file_size: 10 },
    }));
    stream.on('error', () => {});
    source.write(Buffer.from('first'));
    stream.destroy();
    source.end(Buffer.from('last!'));

    const inflight = (service as unknown as { inflight: Map<string, { completion: Promise<void> }> }).inflight.get(FILE_ID);
    await expect(inflight?.completion).resolves.toBeUndefined();
    await expect(fs.readFile(path.join(tempDir, FILE_ID), 'utf8')).resolves.toBe('firstlast!');
  });

  it('上游失败时应向客户端传播错误并删除临时缓存', async () => {
    const source = new PassThrough();
    const { stream } = await service.getOrCacheStream(FILE_ID, 10, async () => ({
      stream: source,
      info: { file_id: 'tg-file', file_path: 'documents/file.bin', file_size: 10 },
    }));
    const clientError = new Promise<Error>((resolve) => stream.once('error', resolve));
    source.destroy(new Error('upstream failed'));

    await expect(clientError).resolves.toMatchObject({ message: 'upstream failed' });
    const inflight = (service as unknown as { inflight: Map<string, { completion: Promise<void> }> }).inflight.get(FILE_ID);
    await expect(inflight?.completion).rejects.toThrow('upstream failed');
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(fs.stat(path.join(tempDir, `${FILE_ID}.tmp`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('首次下载中断后再次请求应立即读取临时缓存并跟随增长，且只回源一次', async () => {
    const source = new PassThrough();
    const fetchFn = jest.fn(async () => ({
      stream: source,
      info: { file_id: 'tg-file', file_path: 'documents/file.bin', file_size: 10 },
    }));
    const first = await service.getOrCacheStream(FILE_ID, 10, fetchFn);
    first.stream.on('error', () => {});
    source.write(Buffer.from('first'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    first.stream.destroy();

    const second = await service.getOrCacheStream(FILE_ID, 10, fetchFn);
    const secondChunks: Buffer[] = [];
    const firstChunk = new Promise<string>((resolve, reject) => {
      second.stream.once('data', (chunk) => resolve(Buffer.from(chunk).toString()));
      second.stream.once('error', reject);
    });
    await expect(firstChunk).resolves.toBe('first');
    expect(source.readableEnded).toBe(false);

    source.end(Buffer.from('last!'));
    for await (const chunk of second.stream) secondChunks.push(Buffer.from(chunk));
    const session = (service as unknown as { inflight: Map<string, { completion: Promise<void> }> }).inflight.get(FILE_ID);
    await session?.completion;

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(`first${Buffer.concat(secondChunks).toString()}`).toBe('firstlast!');
    expect(second.fromCache).toBe(false);
    await expect(fs.readFile(path.join(tempDir, FILE_ID), 'utf8')).resolves.toBe('firstlast!');
  });

  it('跟随下载中断不应影响缓存构建和其他跟随者', async () => {
    const source = new PassThrough();
    const fetchFn = jest.fn(async () => ({
      stream: source,
      info: { file_id: 'tg-file', file_path: 'documents/file.bin', file_size: 10 },
    }));
    const first = await service.getOrCacheStream(FILE_ID, 10, fetchFn);
    first.stream.on('error', () => {});
    first.stream.destroy();
    const abandoned = await service.getOrCacheStream(FILE_ID, 10, fetchFn);
    abandoned.stream.on('error', () => {});
    abandoned.stream.destroy();
    const active = await service.getOrCacheStream(FILE_ID, 10, fetchFn);
    const chunks: Buffer[] = [];
    const reading = (async () => {
      for await (const chunk of active.stream) chunks.push(Buffer.from(chunk));
    })();

    source.end(Buffer.from('cacheddata'));
    await reading;
    const session = (service as unknown as { inflight: Map<string, { completion: Promise<void> }> }).inflight.get(FILE_ID);
    await session?.completion;

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(Buffer.concat(chunks).toString()).toBe('cacheddata');
    await expect(fs.readFile(path.join(tempDir, FILE_ID), 'utf8')).resolves.toBe('cacheddata');
  });

  it('回源失败时应向所有临时缓存跟随者传播错误', async () => {
    const source = new PassThrough();
    const fetchFn = jest.fn(async () => ({
      stream: source,
      info: { file_id: 'tg-file', file_path: 'documents/file.bin', file_size: 10 },
    }));
    const first = await service.getOrCacheStream(FILE_ID, 10, fetchFn);
    first.stream.on('error', () => {});
    const follower = await service.getOrCacheStream(FILE_ID, 10, fetchFn);
    follower.stream.resume();
    const followerError = new Promise<Error>((resolve) => follower.stream.once('error', resolve));

    source.destroy(new Error('upstream failed for all'));

    await expect(followerError).resolves.toMatchObject({ message: 'upstream failed for all' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
