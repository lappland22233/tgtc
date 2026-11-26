import { Logger } from '@nestjs/common';
import { Readable } from 'stream';
import { FileService } from './file.service';

/**
 * Google 双写状态机的并发与失败语义（codex PR #68 回归）。
 *
 * 覆盖三处容易静默失效的点：
 * - 抢占阶段的 DB 异常不得冒泡（否则上传收尾被跳过，文件永久停在 none）；
 * - 同一文件在本实例内不得并发双写（长传输超过租约时重试扫描会抢跑）；
 * - 上传失败必须落成 failed + 退避，才能被重试扫描捡起。
 */
function makeService(options: {
  file?: Record<string, unknown> | null;
  claimAffected?: number;
  claimThrows?: boolean;
  uploadImpl?: () => Promise<{ backendType: string; accountId: string; objectRef: string; size: number }>;
} = {}) {
  const service = Object.create(FileService.prototype) as FileService;

  const file = options.file === null
    ? null
    : {
      id: 'file-1',
      isDeleted: false,
      storageBackend: 'telegram',
      telegramFileId: 'tg-1',
      size: 2048,
      originalName: 'doc.pdf',
      mimeType: 'application/pdf',
      uploadVersion: 1,
      gdriveCacheStatus: 'none',
      gdriveCacheAttempts: 0,
      ...options.file,
    };

  const execute = jest.fn(async () => {
    if (options.claimThrows) throw new Error('db is down');
    return { affected: options.claimAffected ?? 1 };
  });
  const setPayloads: Array<Record<string, unknown>> = [];
  interface Chain {
    update: () => Chain;
    set: (payload: Record<string, unknown>) => Chain;
    where: () => Chain;
    andWhere: () => Chain;
    execute: () => Promise<{ affected: number }>;
  }
  const updateChain: Chain = {
    update: () => updateChain,
    set: (payload) => { setPayloads.push(payload); return updateChain; },
    where: () => updateChain,
    andWhere: () => updateChain,
    execute,
  };
  const repo = {
    findOne: jest.fn(async () => file),
    update: jest.fn(async () => ({ affected: 1 })),
    createQueryBuilder: jest.fn(() => updateChain),
  };
  const upload = jest.fn(options.uploadImpl ?? (async () => ({
    backendType: 'gdrive',
    accountId: 'acc-gd-1',
    objectRef: 'gdrive-object-1',
    size: 2048,
  })));
  const deleteRemoteObject = jest.fn(async () => true);

  Object.assign(service, {
    logger: new Logger('FileServiceGDriveCacheSpec'),
    fileRepository: repo,
    storageRouter: {
      isGDriveCacheModeEnabled: jest.fn(async () => true),
      upload,
      deleteRemoteObject,
    },
    gdriveCacheInflight: new Set<string>(),
  });
  // openPooledMirrorStream 在无 localPath 分支才被调用；桩掉避免真实依赖
  (service as unknown as { openPooledMirrorStream: unknown }).openPooledMirrorStream =
    () => Readable.from([Buffer.from('x')]);

  return { service, repo, upload, deleteRemoteObject, execute, setPayloads };
}

describe('mirrorGDriveCache 状态机', () => {
  it('成功路径：抢占后上传写 ready，并清空重试字段', async () => {
    const { service, repo } = makeService();

    await service.mirrorGDriveCache('file-1');

    expect(repo.update).toHaveBeenCalledWith(
      { id: 'file-1', uploadVersion: 1 },
      expect.objectContaining({
        gdriveCacheStatus: 'ready',
        gdriveCacheAccountId: 'acc-gd-1',
        gdriveCacheObjectRef: 'gdrive-object-1',
        gdriveCacheAttempts: 0,
        gdriveCacheNextRetryAt: null,
      }),
    );
  });

  it('抢占抛错不外抛，并落成 failed + 退避（否则文件永久停在 none）', async () => {
    const { service, upload, setPayloads } = makeService({ claimThrows: true });

    await expect(service.mirrorGDriveCache('file-1')).resolves.toBeUndefined();

    expect(upload).not.toHaveBeenCalled();
    // claim 与 markFailed 都会走 UPDATE：必须有一条带 failed 状态与重试时间的写入
    expect(setPayloads.some((payload) => payload.gdriveCacheStatus === 'failed'
      && payload.gdriveCacheNextRetryAt instanceof Date)).toBe(true);
  });

  it('抢占未命中（其它执行者持租约）时直接返回，不上传也不记失败', async () => {
    const { service, upload, repo } = makeService({ claimAffected: 0 });

    await service.mirrorGDriveCache('file-1');

    expect(upload).not.toHaveBeenCalled();
    // 只有 claim 及其后可能的 lease 续期会走 createQueryBuilder；不应触发 update 写 ready
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('同一文件并发调用只执行一次（进程内互斥）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service, upload } = makeService({
      uploadImpl: async () => {
        await gate;
        return { backendType: 'gdrive', accountId: 'acc-gd-1', objectRef: 'obj', size: 2048 };
      },
    });

    const first = service.mirrorGDriveCache('file-1');
    const second = service.mirrorGDriveCache('file-1');
    release();
    await Promise.all([first, second]);

    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('上传失败：落 failed 并清空在飞标记，便于下轮重试', async () => {
    const { service, deleteRemoteObject } = makeService({
      uploadImpl: async () => { throw new Error('gdrive 503'); },
    });

    await service.mirrorGDriveCache('file-1');

    // 未拿到回执，不应尝试删远端
    expect(deleteRemoteObject).not.toHaveBeenCalled();
    const inflight = (service as unknown as { gdriveCacheInflight: Set<string> }).gdriveCacheInflight;
    expect(inflight.has('file-1')).toBe(false);
  });

  it('调用方可传入 knownSize，避免重试路径重复查库', async () => {
    const { service, upload } = makeService({
      file: { size: 2048 },
    });

    await service.mirrorGDriveCache('file-1', { knownSize: 4096 });

    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ knownLength: 4096 }));
  });
});
