import { existsSync, createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import { FileUploadProcessor } from './file-upload.processor';

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

const fileId = '11111111-1111-4111-8111-111111111111';
const filePath = 'C:/tmp/pending/uuid-upload.bin';
const uploadVersion = 1;

function makeJob(attemptsMade: number) {
  return {
    data: { fileId, filePath, uploadVersion },
    attemptsMade,
  } as any;
}

function makeFile(overrides: Record<string, unknown> = {}) {
  return {
    id: fileId,
    uploadVersion,
    uploadStage: 'pending',
    status: 'processing',
    originalName: 'song.mp3',
    mimeType: 'audio/mpeg',
    ...overrides,
  } as any;
}

function makeRepo() {
  return {
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    query: jest.fn().mockResolvedValue([]),
  };
}

function makeProcessor(repo: ReturnType<typeof makeRepo>, telegram?: any, fileService?: any) {
  return new FileUploadProcessor(
    repo as any,
    telegram || { uploadFile: jest.fn() } as any,
    fileService || { generateAndSaveThumbnail: jest.fn(), generateAndSaveVideoCover: jest.fn() } as any,
  );
}

describe('FileUploadProcessor failure persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCreateReadStream.mockReturnValue({} as any);
    mockedReadFile.mockRejectedValue(new Error('ENOENT')); // loadReceipt 无回执
  });

  it('marks a missing temp file as failed with a fixed, path-free reason', async () => {
    mockedExistsSync.mockReturnValue(false);
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile());
    const processor = makeProcessor(repo);

    await processor.uploadToTelegram(makeJob(2));

    expect(repo.update).toHaveBeenCalledWith(
      { id: fileId, uploadVersion },
      expect.objectContaining({
        status: 'error',
        uploadStage: 'failed',
        uploadFailureReason: '临时文件缺失，上传已放弃',
      }),
    );
    // 固定原因不得包含本地路径
    expect((repo.update.mock.calls[0][1] as any).uploadFailureReason).not.toContain(filePath);
  });

  it('rethrows a missing temp file before the final attempt instead of marking error', async () => {
    mockedExistsSync.mockReturnValue(false);
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile());
    const processor = makeProcessor(repo);

    await expect(processor.uploadToTelegram(makeJob(1))).rejects.toThrow('临时文件暂不可用');
    const errorUpdates = repo.update.mock.calls.filter((c) => (c[1] as any)?.status === 'error');
    expect(errorUpdates).toHaveLength(0);
  });

  it('persists a sanitized Telegram failure reason on exhausted retries', async () => {
    mockedExistsSync.mockReturnValue(true);
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile());
    repo.findOneOrFail.mockResolvedValue(makeFile({ uploadStage: 'uploading' }));
    const telegram = { uploadFile: jest.fn().mockRejectedValue(new Error('Telegram sendDocument 响应缺少可识别的媒体 file_id')) };
    const processor = makeProcessor(repo, telegram);

    await expect(processor.uploadToTelegram(makeJob(2))).rejects.toThrow('缺少可识别的媒体 file_id');

    expect(repo.update).toHaveBeenCalledWith(
      { id: fileId, uploadVersion },
      expect.objectContaining({
        status: 'error',
        uploadStage: 'failed',
        uploadFailureReason: 'Telegram sendDocument 响应缺少可识别的媒体 file_id',
      }),
    );
  });

  it('strips local paths and control characters out of the persisted reason', async () => {
    mockedExistsSync.mockReturnValue(true);
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile());
    repo.findOneOrFail.mockResolvedValue(makeFile({ uploadStage: 'uploading' }));
    const telegram = { uploadFile: jest.fn().mockRejectedValue(new Error(`临时文件暂不可用:\n${filePath}`)) };
    const processor = makeProcessor(repo, telegram);

    await expect(processor.uploadToTelegram(makeJob(2))).rejects.toThrow('临时文件暂不可用');

    const persisted = (repo.update.mock.calls.find((c) => (c[1] as any)?.status === 'error')?.[1] as any)
      ?.uploadFailureReason as string;
    expect(persisted).toBeDefined();
    expect(persisted).not.toContain(filePath);
    expect(persisted).not.toMatch(/\r|\n/);
  });

  it('does not mark error on a non-final Telegram failure', async () => {
    mockedExistsSync.mockReturnValue(true);
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile());
    repo.findOneOrFail.mockResolvedValue(makeFile({ uploadStage: 'uploading' }));
    const telegram = { uploadFile: jest.fn().mockRejectedValue(new Error('Telegram sendDocument 响应缺少可识别的媒体 file_id')) };
    const processor = makeProcessor(repo, telegram);

    await expect(processor.uploadToTelegram(makeJob(1))).rejects.toThrow('缺少可识别的媒体 file_id');

    const errorUpdates = repo.update.mock.calls.filter((c) => (c[1] as any)?.status === 'error');
    expect(errorUpdates).toHaveLength(0);
  });

  it('ignores stale jobs with a mismatched uploadVersion', async () => {
    mockedExistsSync.mockReturnValue(true);
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile({ uploadVersion: 2 }));
    const processor = makeProcessor(repo);

    await processor.uploadToTelegram(makeJob(0));

    expect(repo.update).not.toHaveBeenCalled();
  });

  it('clears the failure reason on remote commit and in the ready update', async () => {
    mockedExistsSync.mockReturnValue(true);
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce(makeFile()).mockResolvedValueOnce(makeFile({ uploadStage: 'remote_committed' }));
    repo.findOneOrFail
      .mockResolvedValueOnce(makeFile({ uploadStage: 'uploading' }))
      .mockResolvedValueOnce(makeFile({ uploadStage: 'remote_committed' }));
    const telegram = { uploadFile: jest.fn().mockResolvedValue({ file_id: 'tg-id', file_path: 'documents/x', file_size: 5 }) };
    const processor = makeProcessor(repo, telegram);

    await processor.uploadToTelegram(makeJob(0));

    // remote_committed 幂等更新同时清空历史失败原因
    expect(repo.update).toHaveBeenCalledWith(
      { id: fileId, uploadVersion },
      expect.objectContaining({ uploadStage: 'remote_committed', uploadFailureReason: null }),
    );
    // ready 原生 SQL 再次清空，覆盖任务恢复/旧数据边界
    expect(repo.query).toHaveBeenCalledWith(
      'UPDATE files SET status = $1, "uploadFailureReason" = NULL WHERE id = $2 AND status = $3',
      ['ready', fileId, 'processing'],
    );
  });
});
