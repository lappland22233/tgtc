import { Logger } from '@nestjs/common';
import { FileService } from './file.service';

/**
 * 存储后端冻结语义（Spec：会话创建时冻结到 File 记录，配置热切换不影响在途任务）。
 *
 * 用 Object.create(prototype) 构造（与 file.service.p2.spec 同一模式），
 * 只装配 createProcessingFile 触达的依赖。
 */
function makeService(opts: { defaultBackend?: string; withRouter?: boolean } = {}) {
  const service = Object.create(FileService.prototype) as FileService;
  const saved: Record<string, unknown>[] = [];
  const getDefaultBackendType = jest.fn(async () => opts.defaultBackend ?? 'telegram');
  // 稳定的内部仓库实例：transaction 回调内外 getRepository 必须返回同一对象
  const innerRepo = {
    save: jest.fn(async (entity: Record<string, unknown>) => {
      const withId = { id: 'file-1', ...entity };
      saved.push(withId);
      return withId;
    }),
    findOne: jest.fn(),
  };
  const manager: { getRepository: () => typeof innerRepo; transaction: jest.Mock } = {
    getRepository: () => innerRepo,
    transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(manager)),
  };
  Object.assign(service, {
    logger: new Logger('FileServiceFreezeSpec'),
    storageRouter: opts.withRouter === false ? null : { getDefaultBackendType },
    uploadConfig: {
      maxFileSizeBytes: 600 * 1024 * 1024,
      getFileSample: jest.fn(async () => Buffer.alloc(8)),
      isFileTypeAllowed: jest.fn(async () => ({ allowed: true })),
    },
    fileRepository: {
      create: jest.fn((input: Record<string, unknown>) => ({ ...input })),
      manager,
      findOne: jest.fn(),
    },
    folderRepository: { findOne: jest.fn() },
    namespaceService: { acquire: jest.fn().mockResolvedValue(undefined) },
    auditService: { log: jest.fn() },
    fileCacheService: { invalidate: jest.fn().mockResolvedValue(undefined), isNoCacheMode: () => false },
    thumbnailService: { deleteThumbnailsForFileId: jest.fn().mockResolvedValue(undefined) },
    fileCopies: null,
  });
  return { service, saved, getDefaultBackendType, manager };
}

const multerFile = {
  size: 1024,
  mimetype: 'application/octet-stream',
  originalname: 'doc.bin',
  path: 'C:/tmp/incoming/doc.bin',
  buffer: Buffer.alloc(1024),
} as never;

const user = { id: 'user-1' } as never;

describe('createProcessingFile 存储后端冻结语义', () => {
  it('新建会话：默认后端 s3 冻结进 File.storageBackend（Worker 按此路由）', async () => {
    const { service, saved, getDefaultBackendType } = makeService({ defaultBackend: 's3' });
    const file = await service.createProcessingFile(multerFile, 'doc.bin', user, undefined, true, null, undefined, { deferCachePrewarm: true });
    expect(getDefaultBackendType).toHaveBeenCalledTimes(1);
    expect(file.storageBackend).toBe('s3');
    expect(saved[0].storageBackend).toBe('s3');
    expect(saved[0].uploadStage).toBe('pending');
  });

  it('未装配存储路由：恒 telegram（可选依赖语义，原链路不变）', async () => {
    const { service, saved } = makeService({ withRouter: false });
    await service.createProcessingFile(multerFile, 'doc.bin', user, undefined, true, null, undefined, { deferCachePrewarm: true });
    expect(saved[0].storageBackend).toBe('telegram');
  });

  it('配置热切换不影响已创建会话：冻结值以创建时刻为准', async () => {
    const { service, saved, getDefaultBackendType } = makeService({ defaultBackend: 'webdav' });
    await service.createProcessingFile(multerFile, 'a.bin', user, undefined, true, null, undefined, { deferCachePrewarm: true });
    // 模拟管理员把默认后端切到 gdrive：已创建记录不受影响
    getDefaultBackendType.mockResolvedValue('gdrive');
    expect(saved[0].storageBackend).toBe('webdav');
    await service.createProcessingFile(multerFile, 'b.bin', user, undefined, true, null, undefined, { deferCachePrewarm: true });
    expect(saved[1].storageBackend).toBe('gdrive');
  });

  it('异步覆盖分支：保持原存储后端不变（旧引用后端类型不丢失，提交后可清理旧对象）', async () => {
    const { service, getDefaultBackendType } = makeService({ defaultBackend: 's3' });
    const target = {
      id: 'file-old',
      uploaderId: 'user-1',
      folderId: null,
      isDeleted: false,
      status: 'ready',
      uploadVersion: 3,
      storageBackend: 'webdav',
      storageAccountId: 'acc-webdav',
      storageObjectRef: '/tgtc/old-object',
      telegramFileId: '',
    };
    const repo = (service as never as { fileRepository: { findOne: jest.Mock; manager: { getRepository: () => { findOne: jest.Mock; save: jest.Mock } } } }).fileRepository;
    repo.findOne.mockResolvedValue(target);
    const lockedSave = jest.fn(async (entity: Record<string, unknown>) => entity);
    const innerRepo = repo.manager.getRepository();
    innerRepo.findOne.mockResolvedValue({ ...target });
    innerRepo.save = lockedSave;

    const reused = await service.createProcessingFile(
      multerFile, 'new-name.bin', user, undefined, true, null, 'file-old', { deferCachePrewarm: true },
    );
    expect(reused.id).toBe('file-old');
    // 默认后端已是 s3，但覆盖会话保持原 webdav（跨后端覆盖仅发生在同步 applyOverwrite 路径）
    const persisted = lockedSave.mock.calls[0][0] as Record<string, unknown>;
    expect(persisted.storageBackend).toBe('webdav');
    expect(persisted.storageObjectRef).toBe('/tgtc/old-object');
    expect(persisted.uploadVersion).toBe(4);
    expect(persisted.uploadStage).toBe('pending');
    expect(getDefaultBackendType).toHaveBeenCalled();
  });
});
