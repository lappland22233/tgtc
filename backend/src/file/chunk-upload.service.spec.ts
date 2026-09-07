import { BadRequestException, HttpStatus } from '@nestjs/common';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';

jest.mock('./file.service', () => ({ FileService: class FileService {} }));

import { ChunkUploadService } from './chunk-upload.service';

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
});
