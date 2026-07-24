import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
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
});
