import { BadRequestException, HttpStatus } from '@nestjs/common';
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
  let service: ChunkUploadService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ChunkUploadService(fileService as any, fileUploadQueue as any, configService as any);
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
  });
});
