import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { CacheDiskManager } from './cache-disk-manager';

// 生产代码通过 require('fs').statfsSync 读取，Jest 中与 import 指向同一 module 对象，
// 因此用 require('fs') 来 spy（import * as fs 的命名空间对象不能可靠 spy）。
const fsModule = require('fs');

describe('CacheDiskManager hasEnoughDiskSpace (G4-07)', () => {
  let cwd: string;
  let manager: CacheDiskManager;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'cache-disk-test-'));
    manager = new CacheDiskManager(cwd);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  it('使用 bavail（可用块）而非 bfree（物理剩余块），避免高估空间', () => {
    const statfsSync = jest.spyOn(fsModule, 'statfsSync').mockReturnValue({
      bsize: 4096,
      // bfree 很高（物理剩余），但 bavail 很低（root 保留/无特权不可用）
      bfree: 1000000,
      bavail: 100,
    });

    // bavail * bsize = 100 * 4096 = 409600 bytes < 1MB → 应判定不足
    expect(manager.hasEnoughDiskSpace(1024 * 1024)).toBe(false);
    expect(statfsSync).toHaveBeenCalledWith(cwd);
  });

  it('bavail 充足时判定空间足够', () => {
    jest.spyOn(fsModule, 'statfsSync').mockReturnValue({
      bsize: 4096,
      bfree: 1000000,
      bavail: 1000000,
    });

    expect(manager.hasEnoughDiskSpace(1024 * 1024)).toBe(true);
  });

  it('statfs 失败时保守返回 false（走 spool/直通）', () => {
    jest.spyOn(fsModule, 'statfsSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(manager.hasEnoughDiskSpace(1024 * 1024)).toBe(false);
  });
});

describe('CacheDiskManager 内存计数总大小 (G4-03)', () => {
  let cwd: string;
  let manager: CacheDiskManager;
  const fileId = '33333333-3333-4333-8333-333333333333';
  const fileId2 = '44444444-4444-4444-8444-444444444444';

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'cache-disk-count-test-'));
    manager = new CacheDiskManager(cwd);
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('registerCache 增量计数，unlinkAllCacheFiles 扣减（O(1) 容量判断）', async () => {
    // 首次调用触发全目录扫描初始化（空目录 → 0）
    expect(await manager.getTotalCacheSize()).toBe(0);

    // 发布两个真实文件，再 registerCache 计数
    await writeFile(manager.getCachePath(fileId), Buffer.alloc(100, 1));
    await writeFile(manager.getCachePath(fileId2), Buffer.alloc(250, 2));
    manager.registerCache(fileId, 100);
    manager.registerCache(fileId2, 250);
    expect(await manager.getTotalCacheSize()).toBe(350);

    // 失效删除第一个文件 → 内存计数扣减 100（无需重扫）
    await manager.unlinkAllCacheFiles(fileId);
    expect(await manager.getTotalCacheSize()).toBe(250);
  });

  it('evictLRU 删除磁盘文件并同步扣减内存计数', async () => {
    const idA = '55555555-5555-4555-8555-555555555555';
    const idB = '66666666-6666-4666-8666-666666666666';
    const fileMap = new Map<string, number>();
    // 写两个真实缓存文件
    await writeFile(manager.getCachePath(idA), Buffer.alloc(100, 1));
    await writeFile(manager.getCachePath(idB), Buffer.alloc(200, 2));
    fileMap.set(idA, 1); // 最近访问较旧
    fileMap.set(idB, 2);

    // 首次 getTotalCacheSize 触发扫描同步（真实文件 300 字节）
    expect(await manager.getTotalCacheSize()).toBe(300);

    const evicted = await manager.evictLRU(150, fileMap); // 释放 150 → 淘汰 idA(100) + idB 一部分
    expect(evicted).toBeGreaterThan(0);
    // evictLRU 后内存计数已同步扣减，二次读取仍为 O(1) 计数且与实际一致
    const remaining = await manager.getTotalCacheSize();
    expect(remaining).toBeLessThan(300);
  });
});
