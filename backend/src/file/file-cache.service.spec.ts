import { mkdtemp, readFile, rm } from 'fs/promises';
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
});
