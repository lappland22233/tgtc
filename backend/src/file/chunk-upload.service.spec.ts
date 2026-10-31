import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

jest.mock('./file.service', () => ({ FileService: class FileService {} }));

import { ChunkUploadService } from './chunk-upload.service';
import { UploadDiskBudgetService } from './upload-disk-budget.service';

const MB = 1024 * 1024;

describe('ChunkUploadService session quota', () => {
  const userId = 'user-1';
  const fileService = {
    getMaxFileSize: jest.fn().mockResolvedValue(100 * MB),
    assertOverwriteTarget: jest.fn().mockResolvedValue(undefined),
    getFileSampleFromPath: jest.fn(),
    isFileTypeAllowed: jest.fn().mockResolvedValue({ allowed: true }),
    getProcessingFileOrThrow: jest.fn(),
    createProcessingFile: jest.fn(),
    softDeleteProcessingFile: jest.fn().mockResolvedValue(undefined),
  };
  const fileUploadQueue = {
    add: jest.fn().mockResolvedValue({}),
    getJob: jest.fn().mockResolvedValue(undefined),
  };
  const configService = { get: jest.fn() };
  const uploadDiskBudget = {
    isStrictMode: jest.fn().mockReturnValue(false),
    acquireSession: jest.fn().mockResolvedValue(undefined),
    transferSessionToJob: jest.fn().mockReturnValue(true),
    transferJobToSession: jest.fn(),
    releaseSession: jest.fn(),
    releaseJob: jest.fn(),
  };
  let service: ChunkUploadService;

  beforeEach(() => {
    jest.clearAllMocks();
    uploadDiskBudget.isStrictMode.mockReturnValue(false);
    service = new ChunkUploadService(fileService as any, fileUploadQueue as any, configService as any, uploadDiskBudget as any);
  });

  afterEach(async () => {
    const sessions = (service as any).sessions as Map<string, any>;
    await Promise.all(
      [...sessions.keys()].map((uploadId) =>
        fsp.rm((service as any).getChunkDir(uploadId), { recursive: true, force: true }),
      ),
    );
  });

  const init = () => service.init('file.bin', MB, 'application/octet-stream', 1, MB, userId);

  it('accepts a session whose declared chunk size is exactly the 16MiB maximum', async () => {
    const chunkSize = 16 * MB;
    const result = await service.init('large.bin', chunkSize, 'video/mp4', 1, chunkSize, userId);

    expect(result).toEqual({ uploadId: expect.any(String) });
  });

  it('rejects the eleventh concurrently active session', async () => {
    await Promise.all(Array.from({ length: 10 }, () => init()));

    await expect(init()).rejects.toThrow('上传会话过多');
  });

  it('returns a structured 429 body for the strict single-chunk lease without disk wording', async () => {
    uploadDiskBudget.isStrictMode.mockReturnValue(true);
    const { uploadId } = await init();

    const release = await service.acquireChunkRequest(uploadId, userId, MB);
    let caught: unknown;
    try {
      await service.acquireChunkRequest(uploadId, userId, MB);
    } catch (error) {
      caught = error;
    } finally {
      release();
    }

    expect(caught).toBeInstanceOf(HttpException);
    const exception = caught as HttpException;
    expect(exception.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    const response = exception.getResponse() as {
      code?: unknown;
      errorCode?: unknown;
      retryAfterMs?: unknown;
      message?: unknown;
    };
    // 与 UploadDiskBudgetService 结构一致：旧前端读 code，新前端读 errorCode。
    expect(response.code).toBe('UPLOAD_DISK_BUDGET_BUSY');
    expect(response.errorCode).toBe('UPLOAD_DISK_BUDGET_BUSY');
    expect(response.retryAfterMs).toBe(5000);
    // 该码只表示进程内租约排队，文案不得含磁盘/空间不足，否则会被前端误归入存储告警。
    expect(String(response.message)).toBe('服务器正在接收上一分片，请稍候');
  });

  it('enforces strict chunk concurrency when disk checks finish together', async () => {
    uploadDiskBudget.isStrictMode.mockReturnValue(true);
    const { uploadId } = await init();
    const results = await Promise.allSettled([
      service.acquireChunkRequest(uploadId, userId, MB),
      service.acquireChunkRequest(uploadId, userId, MB),
    ]);
    const success = results.filter((r): r is PromiseFulfilledResult<() => void> => r.status === 'fulfilled');
    expect(success).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    success[0].value();
  });

  it('does not restart a failed merge when complete is retried', async () => {
    const { uploadId } = await init();
    const session = (service as any).sessions.get(uploadId);
    session.mergeStatus = 'error';
    session.mergeError = 'failed';
    const upload = jest.fn();
    service.triggerMerge(uploadId, userId, upload);
    expect(session.mergeStatus).toBe('error');
    expect(upload).not.toHaveBeenCalled();
  });

  it.each(['done', 'error'] as const)('does not count %s sessions against the active quota', async (status) => {
    await Promise.all(Array.from({ length: 10 }, () => init()));
    const sessions = (service as any).sessions as Map<string, any>;
    for (const session of sessions.values()) session.mergeStatus = status;

    await expect(init()).resolves.toEqual({ uploadId: expect.any(String) });
  });

  it('supports more than 1000 completed sessions remaining queryable', async () => {
    const sessions = (service as any).sessions as Map<string, any>;
    for (let i = 0; i < 1001; i++) {
      sessions.set(`completed-${i}`, { uploadedBy: userId, mergeStatus: 'done' });
    }

    await expect(init()).resolves.toEqual({ uploadId: expect.any(String) });
    expect(sessions.size).toBe(1002);
  });

  it('keeps quota check and registration atomic across concurrent init calls', async () => {
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => init()));
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(10);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);
    }
  });

  it('removes the session and directory when aborted', async () => {
    const { uploadId } = await init();

    await service.abort(uploadId, userId);

    expect((service as any).sessions.has(uploadId)).toBe(false);
    await expect(fsp.stat((service as any).getChunkDir(uploadId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back registration when the chunk directory cannot be created', async () => {
    const mkdirSpy = jest.spyOn(fsp, 'mkdir').mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(init()).rejects.toThrow('disk unavailable');
    expect((service as any).sessions.size).toBe(0);

    mkdirSpy.mockRestore();
  });

  describe('finalizeMerge (G3-05 / G3-06 / G3-07)', () => {
    // 通过 init 建立一个真实会话并写入 merged 文件，再直接驱动私有 finalizeMerge
    async function setupSession() {
      const { uploadId } = await init();
      const session = (service as any).sessions.get(uploadId) as any;
      const mergedPath = path.join((service as any).getChunkDir(uploadId), 'merged');
      await fsp.writeFile(mergedPath, Buffer.alloc(MB, 1));
      return { uploadId, session, mergedPath };
    }

    beforeEach(() => {
      fileService.getFileSampleFromPath.mockReturnValue(Buffer.alloc(8, 1));
      fileService.isFileTypeAllowed.mockResolvedValue({ allowed: true });
      fileService.createProcessingFile.mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        uploadVersion: 1,
        originalName: 'file.bin',
      });
      fileUploadQueue.add.mockResolvedValue({});
    });

    it('G3-05 pre-checks 2x disk space and returns 507 when insufficient', async () => {
      const { session, mergedPath } = await setupSession();
      // 模拟磁盘不足：free - 2x fileSize < minFree
      const statfsSpy = jest.spyOn(fsp, 'statfs').mockResolvedValue({
        bavail: 1,
        bsize: 1024,
      } as any);

      await expect(
        (service as any).finalizeMerge(session, mergedPath, MB, new AbortController().signal),
      ).rejects.toMatchObject({ status: HttpStatus.INSUFFICIENT_STORAGE });

      expect(session.mergeStatus).toBe('error');
      expect(fileService.createProcessingFile).not.toHaveBeenCalled();
      statfsSpy.mockRestore();
    });

    it('G3-06 reuses the saved record on retry instead of creating a duplicate', async () => {
      const { session, mergedPath } = await setupSession();
      // freeBytes = 2GB，远大于 minFreeDiskBytes(1GB) + required(2MB)
      const statfsSpy = jest.spyOn(fsp, 'statfs').mockResolvedValue({ bavail: 2 * 1024 * 1024, bsize: 1024 } as any);

      // 第一次 finalizeMerge：createProcessingFile 建记录，savedFileId 存入 session
      await (service as any).finalizeMerge(session, mergedPath, MB, new AbortController().signal);
      expect(fileService.createProcessingFile).toHaveBeenCalledTimes(1);
      expect(session.savedFileId).toBe('11111111-1111-4111-8111-111111111111');

      // 第二次（重试）：不再 createProcessingFile，而是复用 savedFileId
      fileService.getProcessingFileOrThrow.mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        uploadVersion: 1,
        originalName: 'file.bin',
      });
      const second = await (service as any).finalizeMerge(session, mergedPath, MB, new AbortController().signal);
      expect(fileService.createProcessingFile).toHaveBeenCalledTimes(1);
      expect(fileService.getProcessingFileOrThrow).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        1,
      );
      expect(second.id).toBe('11111111-1111-4111-8111-111111111111');

      statfsSpy.mockRestore();
    });

    it('严格模式在 Worker 可启动前释放分片，仅保留 pending 上传源', async () => {
      uploadDiskBudget.isStrictMode.mockReturnValue(true);
      const { uploadId, session, mergedPath } = await setupSession();
      const pendingPath = path.resolve(process.cwd(), 'tmp', 'uploads', 'pending', '11111111-1111-4111-8111-111111111111');
      fileUploadQueue.add.mockImplementation(async () => {
        await expect(fsp.stat((service as any).getChunkDir(uploadId))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fsp.stat(pendingPath)).resolves.toMatchObject({ size: MB });
        return {};
      });

      await (service as any).finalizeMerge(session, mergedPath, MB, new AbortController().signal);

      expect(uploadDiskBudget.acquireSession).toHaveBeenCalledWith(uploadId, MB);
      expect(uploadDiskBudget.transferSessionToJob).toHaveBeenCalledWith(
        uploadId,
        '11111111-1111-4111-8111-111111111111',
        1,
      );
      await expect(fsp.stat(mergedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fsp.stat(pendingPath)).resolves.toMatchObject({ size: MB });
    });

    it('严格模式在 Redis 入队失败时保留 pending 源和会话租约供安全重试', async () => {
      uploadDiskBudget.isStrictMode.mockReturnValue(true);
      const { uploadId, session, mergedPath } = await setupSession();
      fileUploadQueue.add.mockRejectedValueOnce(new Error('redis unavailable'));

      await expect((service as any).finalizeMerge(session, mergedPath, MB, new AbortController().signal))
        .rejects.toThrow('redis unavailable');

      expect(uploadDiskBudget.transferJobToSession).toHaveBeenCalledWith(
        uploadId,
        '11111111-1111-4111-8111-111111111111',
        1,
      );
      await expect(fsp.stat(mergedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fsp.stat(path.resolve(process.cwd(), 'tmp', 'uploads', 'pending', '11111111-1111-4111-8111-111111111111')))
        .resolves.toMatchObject({ size: MB });
      expect(session.handoffPath).toContain('tmp');
    });
  });

  describe('doMerge large-file single pipeline', () => {
    const pendingDir = path.resolve(process.cwd(), 'tmp', 'uploads', 'pending');

    const createChunk = async (uploadId: string, index: number, fill: number, size: number) => {
      const chunkPath = path.join((service as any).getChunkDir(uploadId), String(index));
      await fsp.writeFile(chunkPath, Buffer.alloc(size, fill));
    };

    const setupMergeSession = async (totalChunks: number, chunkSize: number) => {
      const fileSize = totalChunks * chunkSize;
      const { uploadId } = await service.init('big.bin', fileSize, 'application/octet-stream', totalChunks, chunkSize, userId);
      const session = (service as any).sessions.get(uploadId) as any;
      return { uploadId, session };
    };

    let statfsSpy: jest.SpyInstance;

    beforeEach(() => {
      // doMerge 成功路径会进入 finalizeMerge：准备充足的磁盘与文件服务 mock
      statfsSpy = jest.spyOn(fsp, 'statfs').mockResolvedValue({ bavail: 2 * 1024 * 1024, bsize: 1024 } as any);
      fileService.getFileSampleFromPath.mockReturnValue(Buffer.alloc(8, 1));
      fileService.isFileTypeAllowed.mockResolvedValue({ allowed: true });
      fileService.createProcessingFile.mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        uploadVersion: 1,
        originalName: 'big.bin',
      });
      fileUploadQueue.add.mockResolvedValue({});
    });

    afterEach(async () => {
      statfsSpy.mockRestore();
      await fsp.rm(path.join(pendingDir, '11111111-1111-4111-8111-111111111111'), { force: true });
      await fsp.rm(path.join(pendingDir, '11111111-1111-4111-8111-111111111111.telegram.json'), { force: true });
    });

    it('merges 250 chunks in order via a single pipeline with bounded target-stream listeners', async () => {
      const totalChunks = 250;
      const chunkSize = 64 * 1024;
      const { uploadId, session } = await setupMergeSession(totalChunks, chunkSize);
      for (let i = 0; i < totalChunks; i++) {
        await createChunk(uploadId, i, i % 256, chunkSize);
      }

      // 统计目标 WriteStream 的 error 监听器注册次数
      //（fs 模块的 createWriteStream 属性不可重定义，改用原型方法计数）
      const writeStreamProto = (fs.WriteStream as any).prototype;
      const origOn = writeStreamProto.on;
      const origOnce = writeStreamProto.once;
      let errorListenerRegistrations = 0;
      writeStreamProto.on = function (event: string, handler: any) {
        if (event === 'error') errorListenerRegistrations++;
        return origOn.call(this, event, handler);
      };
      writeStreamProto.once = function (event: string, handler: any) {
        if (event === 'error') errorListenerRegistrations++;
        return origOnce.call(this, event, handler);
      };

      const warnings: string[] = [];
      const warningListener = (w: Error) => {
        if (w.name === 'MaxListenersExceededWarning') warnings.push(w.name);
      };
      process.on('warning', warningListener);

      try {
        await (service as any).doMerge(session, jest.fn(), new AbortController().signal);
        // 等待可能延迟投递的 process warning
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        writeStreamProto.on = origOn;
        writeStreamProto.once = origOnce;
        process.off('warning', warningListener);
      }

      // 内容与顺序一致（逐片填充 i % 256）：合并产物已原子交接为 pending，
      // 不再保留 session/merged 或原分片目录占用一份完整数据。
      const expected = Buffer.concat(
        Array.from({ length: totalChunks }, (_, i) => Buffer.alloc(chunkSize, i % 256)),
      );
      const pendingPath = path.join(pendingDir, '11111111-1111-4111-8111-111111111111');
      const handedOff = await fsp.readFile(pendingPath);
      expect(handedOff.equals(expected)).toBe(true);
      await expect(fsp.stat((service as any).getChunkDir(uploadId))).rejects.toMatchObject({ code: 'ENOENT' });

      // 目标流监听器不随片数增长：旧实现对同一 WriteStream 循环 pipeline，
      // 每片重复注册且清理延迟到 close，125 片即触发 MaxListenersExceededWarning；
      // 单管道实现整个合并只注册个位数
      expect(errorListenerRegistrations).toBeLessThanOrEqual(20);
      expect(warnings).toHaveLength(0);
    });

    it('cancels mid-merge, removes the partial merged file and keeps original chunks', async () => {
      const totalChunks = 8;
      const chunkSize = 2 * 1024 * 1024; // 16MiB 总量，走大文件分支
      const { uploadId, session } = await setupMergeSession(totalChunks, chunkSize);
      for (let i = 0; i < totalChunks; i++) {
        await createChunk(uploadId, i, i % 256, chunkSize);
      }

      const controller = new AbortController();
      const chunk5Path = path.join((service as any).getChunkDir(uploadId), '5');
      const realStat = fsp.stat;
      // 在第 5 片 stat 完成时取消（合并已在进行中）
      const statSpy = jest.spyOn(fsp, 'stat').mockImplementation((async (target: any) => {
        const result = await realStat(target);
        if (target === chunk5Path) controller.abort();
        return result;
      }) as any);

      try {
        await expect((service as any).doMerge(session, jest.fn(), controller.signal))
          .rejects.toThrow('分片合并已取消');
      } finally {
        statSpy.mockRestore();
      }

      // 部分合并产物被清理，原分片全部保留（仍有重试价值）
      const dirPath = (service as any).getChunkDir(uploadId);
      await expect(fsp.stat(path.join(dirPath, 'merged'))).rejects.toMatchObject({ code: 'ENOENT' });
      for (let i = 0; i < totalChunks; i++) {
        await expect(fsp.stat(path.join(dirPath, String(i)))).resolves.toBeTruthy();
      }
    });

    it('maps a missing chunk to a retryable error and removes the partial merged file', async () => {
      const { uploadId, session } = await setupMergeSession(2, 8 * 1024 * 1024);
      await createChunk(uploadId, 0, 1, 8 * 1024 * 1024);
      // 分片 1 缺失

      const dirPath = (service as any).getChunkDir(uploadId);
      await expect((service as any).doMerge(session, jest.fn(), new AbortController().signal))
        .rejects.toThrow('分片 1 缺失，请重新上传');
      await expect(fsp.stat(path.join(dirPath, 'merged'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  // M3：分片合并信号量的回收（原实现 Map 只 get/set、永不 delete，长期运行内存单调增长）。
  describe('merge semaphore lifecycle (M3)', () => {
    const makeSession = (userId: string): any => ({
      uploadedBy: userId,
      mergeAbortController: new AbortController(),
    });

    beforeEach(() => {
      jest.spyOn(service as any, 'scheduleCleanup').mockImplementation(() => undefined);
    });

    it('recycles the per-user semaphore after a successful merge', async () => {
      jest.spyOn(service as any, 'doMerge').mockResolvedValue({ id: 'f1', originalName: 'x.bin' });

      await (service as any).runMergeWithSemaphore(makeSession('u1'), jest.fn(), 'upload-1');

      expect((service as any).getMergeSemaphoreStats()).toEqual({
        activeUsers: 0,
        trackedRefs: 0,
        recycled: 1,
        globalBusy: false,
      });
    });

    it('recycles the per-user semaphore on the failure path', async () => {
      jest.spyOn(service as any, 'doMerge').mockRejectedValue(new Error('boom'));

      const session = makeSession('u-err');
      await (service as any).runMergeWithSemaphore(session, jest.fn(), 'upload-err');

      expect(session.mergeStatus).toBe('error');
      expect((service as any).getMergeSemaphoreStats()).toEqual({
        activeUsers: 0,
        trackedRefs: 0,
        recycled: 1,
        globalBusy: false,
      });
    });

    it('keeps per-user concurrency at 1 when a waiter is queued', async () => {
      let active = 0;
      let maxActive = 0;
      jest.spyOn(service as any, 'doMerge').mockImplementation(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { id: 'f1', originalName: 'x.bin' };
      });

      const first = (service as any).runMergeWithSemaphore(makeSession('u2'), jest.fn(), 'm-1');
      // 确保首个合并已取得用户级信号量后再发起第二个
      await Promise.resolve();
      const second = (service as any).runMergeWithSemaphore(makeSession('u2'), jest.fn(), 'm-2');
      await Promise.all([first, second]);

      expect(maxActive).toBe(1);
      // 等待者未导致信号量被提前回收而产生第二个实例
      expect((service as any).getMergeSemaphoreStats().activeUsers).toBe(0);
    });

    it('tracks independent semaphores per user', async () => {
      const seen: number[] = [];
      jest.spyOn(service as any, 'doMerge').mockImplementation(async () => {
        seen.push((service as any).getMergeSemaphoreStats().activeUsers);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { id: 'f1', originalName: 'x.bin' };
      });

      await Promise.all([
        (service as any).runMergeWithSemaphore(makeSession('a'), jest.fn(), 'a'),
        (service as any).runMergeWithSemaphore(makeSession('b'), jest.fn(), 'b'),
      ]);

      expect(seen.filter((n) => n >= 1).length).toBeGreaterThan(0);
      expect((service as any).getMergeSemaphoreStats().activeUsers).toBe(0);
      expect((service as any).getMergeSemaphoreStats().trackedRefs).toBe(0);
    });
  });
});

// 僵尸会话：init 成功后客户端断连，既无 complete 也无 abort。
// 旧实现把 mergeStatus='pending' 当作活跃会话永久跳过清理，且过期清理路径不释放
// UploadDiskBudgetService 的 session 租约，导致严格模式此后所有上传永远 429。
describe('ChunkUploadService 空闲会话回收', () => {
  const userId = 'user-reclaim';
  const fileService = {
    getMaxFileSize: jest.fn().mockResolvedValue(100 * MB),
    assertOverwriteTarget: jest.fn().mockResolvedValue(undefined),
    softDeleteProcessingFile: jest.fn().mockResolvedValue(undefined),
  };
  const fileUploadQueue = {
    add: jest.fn().mockResolvedValue({}),
    getJob: jest.fn().mockResolvedValue(undefined),
  };
  const configService = { get: jest.fn() };
  const uploadDiskBudget = {
    isStrictMode: jest.fn().mockReturnValue(true),
    acquireSession: jest.fn().mockResolvedValue(undefined),
    transferSessionToJob: jest.fn().mockReturnValue(true),
    transferJobToSession: jest.fn(),
    releaseSession: jest.fn().mockReturnValue(true),
    releaseJob: jest.fn().mockReturnValue(true),
    describeActiveLease: jest.fn().mockReturnValue(null),
  };
  let service: ChunkUploadService;
  let tempRoot: string;

  const sessions = () => (service as any).sessions as Map<string, any>;
  const initSession = (fileName = 'file.bin') =>
    service.init(fileName, MB, 'application/octet-stream', 1, MB, userId);
  const ageSession = (uploadId: string, minutes: number) => {
    const session = sessions().get(uploadId);
    session.lastActivityAt = new Date(Date.now() - minutes * 60 * 1000);
    return session;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // 隔离到临时工作目录，避免每个用例在仓库 tmp/uploads 留下 UUID 空目录。
    tempRoot = await fsp.mkdtemp(path.join(tmpdir(), 'chunk-reclaim-'));
    jest.spyOn(process, 'cwd').mockReturnValue(tempRoot);
    service = new ChunkUploadService(fileService as any, fileUploadQueue as any, configService as any, uploadDiskBudget as any);
  });

  afterEach(async () => {
    (service as any).inFlightRequestsBySession?.clear?.();
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    jest.restoreAllMocks();
  });

  it('pending 会话空闲超过 10 分钟：删除分片目录并释放严格模式租约', async () => {
    const { uploadId } = await initSession();
    const dir = (service as any).getChunkDir(uploadId);
    await fsp.writeFile(path.join(dir, '0'), Buffer.alloc(2048));
    ageSession(uploadId, 11);

    await expect(service.cleanupExpiredSessions()).resolves.toEqual({ cleaned: 1, releasedLeases: 1 });

    expect(sessions().has(uploadId)).toBe(false);
    await expect(fsp.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(uploadDiskBudget.releaseSession).toHaveBeenCalledWith(uploadId);
  });

  it('pending 会话空闲不足 10 分钟：保留会话与租约', async () => {
    const { uploadId } = await initSession();
    ageSession(uploadId, 5);

    await expect(service.cleanupExpiredSessions()).resolves.toEqual({ cleaned: 0, releasedLeases: 0 });

    expect(sessions().has(uploadId)).toBe(true);
    expect(uploadDiskBudget.releaseSession).not.toHaveBeenCalled();
  });

  it('仍有分片请求体在接收时不回收（落盘后才刷新 lastActivityAt）', async () => {
    const { uploadId } = await initSession();
    ageSession(uploadId, 30);
    (service as any).inFlightRequestsBySession.set(uploadId, 1);

    await expect(service.cleanupExpiredSessions()).resolves.toEqual({ cleaned: 0, releasedLeases: 0 });

    expect(sessions().has(uploadId)).toBe(true);
    expect(uploadDiskBudget.releaseSession).not.toHaveBeenCalled();
  });

  it('合并中的会话不受 10 分钟规则影响，超过 35 分钟只告警一次且不删除', async () => {
    const { uploadId } = await initSession();
    const session = ageSession(uploadId, 40);
    session.mergeStatus = 'merging';
    const warn = jest.spyOn((service as any).logger, 'warn');

    await service.cleanupExpiredSessions();
    const warnCount = warn.mock.calls.length;
    await service.cleanupExpiredSessions();

    expect(sessions().has(uploadId)).toBe(true);
    expect(uploadDiskBudget.releaseSession).not.toHaveBeenCalled();
    expect(warnCount).toBe(1);
    expect(warn.mock.calls.length).toBe(1);
    expect(String(warn.mock.calls[0][0])).toContain('未收敛');
    warn.mockRestore();
  });

  it('目录删除失败时回滚 reclaiming、重建目录并保留租约，下一轮再试', async () => {
    const { uploadId } = await initSession();
    const dir = (service as any).getChunkDir(uploadId);
    ageSession(uploadId, 11);
    const rmSpy = jest.spyOn(fsp, 'rm').mockRejectedValueOnce(new Error('EBUSY'));
    try {
      await expect(service.cleanupExpiredSessions()).resolves.toEqual({ cleaned: 0, releasedLeases: 0 });
    } finally {
      rmSpy.mockRestore();
    }

    const session = sessions().get(uploadId);
    expect(session.reclaiming).toBe(false);
    expect(session.reclaimFailures).toBe(1);
    expect(uploadDiskBudget.releaseSession).not.toHaveBeenCalled();
    // 会话恢复可用（不是永久 404），且目录已重建，续传不会因父目录缺失 500
    await expect(service.getStatus(uploadId, userId)).resolves.toMatchObject({ mergeStatus: 'pending' });
    await expect(fsp.stat(dir)).resolves.toBeTruthy();
  });

  it('并发回收单飞：同一批目录只删一次', async () => {
    const { uploadId } = await initSession();
    ageSession(uploadId, 11);
    const rmSpy = jest.spyOn(fsp, 'rm');

    const [first, second] = await Promise.all([
      service.cleanupExpiredSessions(),
      service.cleanupExpiredSessions(),
    ]);

    expect(rmSpy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first).toEqual({ cleaned: 1, releasedLeases: 1 });
    rmSpy.mockRestore();
  });

  it('init 前主动回收：过期会话不再占用配额，且租约在申请前已释放', async () => {
    const staleIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { uploadId } = await initSession(`stale-${i}.bin`);
      staleIds.push(uploadId);
    }
    // 全部建好后再统一老化：init 会主动回收，逐条老化会被后续 init 提前清掉。
    for (const staleId of staleIds) ageSession(staleId, 11);
    uploadDiskBudget.releaseSession.mockClear();
    uploadDiskBudget.acquireSession.mockClear();

    // 不做主动回收时这里会以「上传会话过多」拒绝
    const { uploadId: freshId } = await initSession('fresh.bin');

    for (const staleId of staleIds) {
      expect(sessions().has(staleId)).toBe(false);
      expect(uploadDiskBudget.releaseSession).toHaveBeenCalledWith(staleId);
    }
    expect(sessions().has(freshId)).toBe(true);
    // 先释放旧租约，再为新会话申请，严格模式不会在同一份闭包内自我阻塞
    const releaseOrder = uploadDiskBudget.releaseSession.mock.invocationCallOrder[0];
    const acquireOrder = uploadDiskBudget.acquireSession.mock.invocationCallOrder[0];
    expect(releaseOrder).toBeLessThan(acquireOrder);
  });

  it('缺少 lastActivityAt 的历史/注入条目不会被误删', async () => {
    sessions().set('legacy-session', { uploadedBy: userId, mergeStatus: 'pending' });

    await expect(service.cleanupExpiredSessions()).resolves.toEqual({ cleaned: 0, releasedLeases: 0 });

    expect(sessions().has('legacy-session')).toBe(true);
  });

  it('回收中的会话对所有入口一律按过期处理，避免与目录删除竞态', async () => {
    const { uploadId } = await initSession();
    sessions().get(uploadId).reclaiming = true;

    await expect(service.getStatus(uploadId, userId)).rejects.toThrow('上传会话不存在或已过期');
    await expect(service.abort(uploadId, userId)).resolves.toBeUndefined();
    expect(() => service.triggerMerge(uploadId, userId, jest.fn())).toThrow('上传会话不存在或已过期');
  });

  it('回收异常不阻断 init，且单飞状态不会卡死', async () => {
    const spy = jest
      .spyOn(service as any, 'doReclaimExpiredSessions')
      .mockRejectedValueOnce(new Error('scan failed'));

    await expect(initSession('tolerant.bin')).resolves.toEqual({ uploadId: expect.any(String) });
    expect(spy).toHaveBeenCalled();
    expect((service as any).reclaimInFlight).toBeNull();
    await expect(initSession('tolerant-2.bin')).resolves.toEqual({ uploadId: expect.any(String) });
  });

  it('done 会话的 job 租约不被虚报释放：clean 成功但 releasedLeases=0', async () => {
    const { uploadId } = await initSession();
    ageSession(uploadId, 11).mergeStatus = 'done';
    // done 会话的租约已转交 Worker，releaseSession 按 key 匹配返回 false
    uploadDiskBudget.releaseSession.mockReturnValueOnce(false);

    await expect(service.cleanupExpiredSessions()).resolves.toEqual({ cleaned: 1, releasedLeases: 0 });

    expect(sessions().has(uploadId)).toBe(false);
    uploadDiskBudget.releaseSession.mockReturnValue(true);
  });

  it('孤儿对账：租约指向已不存在的会话时直接释放', async () => {
    await initSession();
    uploadDiskBudget.describeActiveLease.mockReturnValue({
      key: 'session:99999999-9999-4999-8999-999999999999',
      fileSize: 1024,
      heldMs: 120_000,
    });

    await expect(service.cleanupExpiredSessions()).resolves.toEqual({ cleaned: 0, releasedLeases: 1 });

    expect(uploadDiskBudget.releaseSession).toHaveBeenCalledWith('99999999-9999-4999-8999-999999999999');
    uploadDiskBudget.describeActiveLease.mockReturnValue(null);
  });

  it('孤儿对账不碰现存会话的租约与 job: 租约', async () => {
    const { uploadId } = await initSession();

    uploadDiskBudget.describeActiveLease.mockReturnValue({ key: `session:${uploadId}`, fileSize: 1024, heldMs: 120_000 });
    await expect(service.cleanupExpiredSessions()).resolves.toEqual({ cleaned: 0, releasedLeases: 0 });

    uploadDiskBudget.describeActiveLease.mockReturnValue({ key: 'job:file-1:1', fileSize: 1024, heldMs: 120_000 });
    await expect(service.cleanupExpiredSessions()).resolves.toEqual({ cleaned: 0, releasedLeases: 0 });

    expect(uploadDiskBudget.releaseSession).not.toHaveBeenCalled();
    uploadDiskBudget.describeActiveLease.mockReturnValue(null);
  });

  it('联调真实 UploadDiskBudgetService：僵尸会话不再阻塞下一次 init', async () => {
    const repository = { findOne: jest.fn().mockResolvedValue(null) };
    const budget = new UploadDiskBudgetService(
      repository as any,
      { isNoCacheMode: () => true } as any,
      { get: () => undefined } as any,
    );
    const realService = new ChunkUploadService(
      fileService as any,
      fileUploadQueue as any,
      configService as any,
      budget,
    );

    const { uploadId: zombieId } = await realService.init('zombie.mp4', MB, 'video/mp4', 1, MB, userId);
    expect(budget.describeActiveLease()?.key).toBe(`session:${zombieId}`);
    (realService as any).sessions.get(zombieId).lastActivityAt = new Date(Date.now() - 11 * 60 * 1000);

    try {
      const { uploadId: freshId } = await realService.init('fresh.mp4', MB, 'video/mp4', 1, MB, userId);

      expect((realService as any).sessions.has(zombieId)).toBe(false);
      expect(budget.describeActiveLease()?.key).toBe(`session:${freshId}`);
    } finally {
      const lease = budget.describeActiveLease();
      if (lease?.key.startsWith('session:')) {
        budget.releaseSession(lease.key.slice('session:'.length));
      }
    }
  });
});
