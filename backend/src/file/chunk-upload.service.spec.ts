import { BadRequestException } from '@nestjs/common';
import { promises as fsp } from 'fs';

jest.mock('./file.service', () => ({ FileService: class FileService {} }));

import { ChunkUploadService } from './chunk-upload.service';

const MB = 1024 * 1024;

describe('ChunkUploadService session quota', () => {
  const userId = 'user-1';
  const fileService = {
    getMaxFileSize: jest.fn().mockResolvedValue(100 * MB),
    assertOverwriteTarget: jest.fn().mockResolvedValue(undefined),
  };
  const fileUploadQueue = { add: jest.fn() };
  let service: ChunkUploadService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ChunkUploadService(fileService as any, fileUploadQueue as any);
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
});
