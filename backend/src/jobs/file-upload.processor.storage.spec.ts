import { existsSync, createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import { FileUploadProcessor } from './file-upload.processor';
import { StorageUploadUnavailableError } from '../storage/storage.types';

jest.mock('file-type', () => ({
  fileTypeFromBuffer: jest.fn(),
}), { virtual: true });

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  createReadStream: jest.fn(),
  existsSync: jest.fn(),
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
  rename: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

const mockedExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockedCreateReadStream = createReadStream as jest.MockedFunction<typeof createReadStream>;
const mockedReadFile = readFile as jest.MockedFunction<typeof readFile>;

const fileId = '22222222-2222-4222-8222-222222222222';
const filePath = 'C:/tmp/pending/uuid-storage.bin';
const uploadVersion = 1;

function makeJob(attemptsMade: number) {
  return { data: { fileId, filePath, uploadVersion }, attemptsMade } as any;
}

function makeFile(overrides: Record<string, unknown> = {}) {
  return {
    id: fileId,
    uploadVersion,
    uploadStage: 'pending',
    status: 'processing',
    originalName: 'doc.pdf',
    mimeType: 'application/pdf',
    size: 2048,
    storageBackend: 's3',
    storageAccountId: null,
    storageObjectRef: null,
    telegramFileId: '',
    ...overrides,
  } as any;
}

function makeRepo() {
  const query = jest.fn().mockResolvedValue([{ id: fileId }]);
  return {
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    query,
    manager: { query },
  };
}

function makeFileService() {
  return {
    generateAndSaveThumbnail: jest.fn(),
    generateAndSaveVideoCover: jest.fn(),
    registerPrimaryTelegramSource: jest.fn(),
    triggerMirrorForFile: jest.fn(),
    cleanupNonTelegramObject: jest.fn().mockResolvedValue(undefined),
  };
}

function makeStorageRouter(receipt?: { objectRef: string; accountId: string; size: number }) {
  return {
    upload: jest.fn().mockResolvedValue({
      backendType: 's3',
      accountId: receipt?.accountId ?? 'acc-1',
      objectRef: receipt?.objectRef ?? 'prefix/uuid-doc.pdf',
      size: receipt?.size ?? 2048,
    }),
  };
}

function makeProcessor(
  repo: ReturnType<typeof makeRepo>,
  fileService: ReturnType<typeof makeFileService>,
  storageRouter: ReturnType<typeof makeStorageRouter> | undefined,
  telegram?: any,
) {
  return new FileUploadProcessor(
    repo as any,
    telegram ?? ({ uploadFile: jest.fn() } as any),
    fileService as any,
    undefined,
    undefined,
    storageRouter as any,
  );
}

describe('FileUploadProcessor 非 TG 存储后端分支', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedCreateReadStream.mockReturnValue({} as any);
    mockedReadFile.mockRejectedValue(new Error('ENOENT')); // 无回执
  });

  it('S3 文件经存储路由上传：提交写存储引用、TG 专属步骤全部跳过', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile());
    repo.findOneOrFail.mockResolvedValue(makeFile({
      uploadStage: 'remote_committed',
      storageAccountId: 'acc-1',
      storageObjectRef: 'prefix/uuid-doc.pdf',
    }));
    const fileService = makeFileService();
    const telegram = { uploadFile: jest.fn(), releaseLocalFile: jest.fn() };
    const storageRouter = makeStorageRouter();
    const processor = makeProcessor(repo, fileService, storageRouter, telegram);

    await processor.uploadToTelegram(makeJob(0));

    expect(storageRouter.upload).toHaveBeenCalledWith(expect.objectContaining({
      backendType: 's3',
      objectName: 'doc.pdf',
      knownLength: 2048,
    }));
    // TG 上传/本地媒体释放/主副本登记/镜像触发一律不执行
    expect(telegram.uploadFile).not.toHaveBeenCalled();
    expect(telegram.releaseLocalFile).not.toHaveBeenCalled();
    expect(fileService.registerPrimaryTelegramSource).not.toHaveBeenCalled();
    expect(fileService.triggerMirrorForFile).not.toHaveBeenCalled();
    // 提交点写入存储引用，TG 引用清空
    expect(repo.update).toHaveBeenCalledWith(
      { id: fileId, uploadVersion },
      expect.objectContaining({
        storageBackend: 's3',
        storageAccountId: 'acc-1',
        storageObjectRef: 'prefix/uuid-doc.pdf',
        telegramFileId: '',
        uploadStage: 'remote_committed',
      }),
    );
    // ready 置位经 RETURNING 门禁
    expect(repo.manager.query).toHaveBeenCalled();
  });

  it('回执缺少对象引用时拒绝提交（禁止假成功）', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile());
    repo.findOneOrFail.mockResolvedValue(makeFile({ uploadStage: 'uploading' }));
    const storageRouter = { upload: jest.fn().mockResolvedValue({ backendType: 's3', accountId: 'acc-1', objectRef: '', size: 2048 }) };
    const processor = makeProcessor(repo, makeFileService(), storageRouter as any);

    await expect(processor.uploadToTelegram(makeJob(0))).rejects.toThrow('存储远端回执缺少有效对象引用');
  });

  it('非 TG 覆盖：提交成功后清理旧对象（共享检查委托 FileService）', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile({
      storageAccountId: 'acc-old',
      storageObjectRef: 'old-ref',
    }));
    // 第一次 findOneOrFail（CAS 后重读）仍持旧引用；提交后重读才是新引用
    repo.findOneOrFail
      .mockResolvedValueOnce(makeFile({
        uploadStage: 'uploading',
        storageAccountId: 'acc-old',
        storageObjectRef: 'old-ref',
      }))
      .mockResolvedValue(makeFile({
        uploadStage: 'remote_committed',
        storageAccountId: 'acc-1',
        storageObjectRef: 'new-ref',
      }));
    const fileService = makeFileService();
    const processor = makeProcessor(repo, fileService, makeStorageRouter({ objectRef: 'new-ref', accountId: 'acc-1', size: 2048 }));

    await processor.uploadToTelegram(makeJob(0));

    expect(fileService.cleanupNonTelegramObject).toHaveBeenCalledWith(expect.objectContaining({
      storageBackend: 's3',
      storageAccountId: 'acc-old',
      storageObjectRef: 'old-ref',
    }));
  });

  it('已提交但对象引用缺失的非 TG 文件不得置 ready（标记 error）', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile({ uploadStage: 'committed', storageObjectRef: '' }));
    repo.findOneOrFail.mockResolvedValue(makeFile({ uploadStage: 'committed', storageObjectRef: '' }));
    const processor = makeProcessor(repo, makeFileService(), makeStorageRouter());

    await processor.uploadToTelegram(makeJob(0));

    expect(repo.update).toHaveBeenCalledWith(
      { id: fileId, uploadVersion },
      expect.objectContaining({
        status: 'error',
        uploadStage: 'failed',
        uploadFailureReason: '存储远端提交缺少有效对象引用，已标记上传失败',
      }),
    );
    expect(repo.manager.query).not.toHaveBeenCalled();
  });

  it('存储路由未装配时非 TG 文件诊断性失败（不误走 TG 链路）', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile());
    repo.findOneOrFail.mockResolvedValue(makeFile({ uploadStage: 'uploading' }));
    const telegram = { uploadFile: jest.fn() };
    const processor = makeProcessor(repo, makeFileService(), undefined, telegram);

    await expect(processor.uploadToTelegram(makeJob(0))).rejects.toThrow('存储后端未装配');
    expect(telegram.uploadFile).not.toHaveBeenCalled();
  });

  it('非 admissionOnly 的存储不可用错误向上传播（消耗 Bull 重试）', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile());
    repo.findOneOrFail.mockResolvedValue(makeFile({ uploadStage: 'uploading' }));
    const storageRouter = { upload: jest.fn().mockRejectedValue(new StorageUploadUnavailableError(false)) };
    const processor = makeProcessor(repo, makeFileService(), storageRouter as any);

    await expect(processor.uploadToTelegram(makeJob(0))).rejects.toBeInstanceOf(StorageUploadUnavailableError);
  });

  it('TG 文件（storageBackend=telegram）不受存储分支影响', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile({ storageBackend: 'telegram', telegramFileId: 'tg-file-id' }));
    repo.findOneOrFail.mockResolvedValue(makeFile({
      storageBackend: 'telegram',
      uploadStage: 'remote_committed',
      telegramFileId: 'tg-file-id',
    }));
    const telegram = {
      uploadFile: jest.fn().mockResolvedValue({ file_id: 'tg-file-id', file_path: '', file_size: 2048 }),
      releaseLocalFile: jest.fn(),
    };
    const fileService = makeFileService();
    const storageRouter = makeStorageRouter();
    const processor = makeProcessor(repo, fileService, storageRouter, telegram);

    await processor.uploadToTelegram(makeJob(0));

    expect(storageRouter.upload).not.toHaveBeenCalled();
    expect(telegram.uploadFile).toHaveBeenCalled();
  });
});