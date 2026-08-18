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
    update: jest.fn().mockResolvedValue({ affected: 1 }),
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
    repo.findOne
      .mockResolvedValueOnce(makeFile())
      .mockResolvedValueOnce(makeFile({ uploadStage: 'remote_committed', telegramFileId: 'tg-id' }));
    repo.findOneOrFail
      .mockResolvedValueOnce(makeFile({ uploadStage: 'uploading' }))
      .mockResolvedValueOnce(makeFile({ uploadStage: 'remote_committed', telegramFileId: 'tg-id' }));
    const telegram = { uploadFile: jest.fn().mockResolvedValue({ file_id: 'tg-id', file_path: 'documents/x', file_size: 5 }) };
    const processor = makeProcessor(repo, telegram);

    await processor.uploadToTelegram(makeJob(0));

    // remote_committed 幂等更新同时清空历史失败原因
    expect(repo.update).toHaveBeenCalledWith(
      { id: fileId, uploadVersion },
      expect.objectContaining({ uploadStage: 'remote_committed', uploadFailureReason: null }),
    );
    // ready 原生 SQL 再次清空，覆盖任务恢复/旧数据边界；status IN 允许覆盖僵尸任务误标的 error
    expect(repo.query).toHaveBeenCalledWith(
      'UPDATE files SET status = $1, "uploadFailureReason" = NULL WHERE id = $2 AND status IN ($3, $4) AND "uploadVersion" = $5',
      ['ready', fileId, 'processing', 'error', uploadVersion],
    );
  });

  it('recovers ready when the committed record was mistakenly marked error by the stale-processing task', async () => {
    mockedExistsSync.mockReturnValue(true);
    const repo = makeRepo();
    // 已提交但被僵尸任务误标 error → 上传成功恢复时仍可置 ready
    repo.findOne.mockResolvedValue(makeFile({ uploadStage: 'remote_committed', telegramFileId: 'tg-id', status: 'error' }));
    repo.findOneOrFail.mockResolvedValue(makeFile({ uploadStage: 'remote_committed', telegramFileId: 'tg-id', status: 'error' }));
    const processor = makeProcessor(repo, { uploadFile: jest.fn() });

    await processor.uploadToTelegram(makeJob(0));

    expect(repo.query).toHaveBeenCalledWith(
      'UPDATE files SET status = $1, "uploadFailureReason" = NULL WHERE id = $2 AND status IN ($3, $4) AND "uploadVersion" = $5',
      ['ready', fileId, 'processing', 'error', uploadVersion],
    );
  });

  it('marks error instead of ready when the committed record lacks a telegramFileId', async () => {
    mockedExistsSync.mockReturnValue(true);
    const repo = makeRepo();
    // 数据库已提交（remote_committed）但 telegramFileId 为空：不允许置 ready
    repo.findOne.mockResolvedValue(makeFile({ uploadStage: 'remote_committed', telegramFileId: '' }));
    repo.findOneOrFail.mockResolvedValue(makeFile({ uploadStage: 'remote_committed', telegramFileId: '' }));
    const processor = makeProcessor(repo, { uploadFile: jest.fn() });

    await processor.uploadToTelegram(makeJob(0));

    // 不应执行置 ready 的 SQL
    const readyQueries = repo.query.mock.calls.filter((c) => String(c[0]).includes("status = $1"));
    expect(readyQueries).toHaveLength(0);
    // 置 ready 前置校验：缺 file_id 时标记 error（条件更新，uploadVersion 对齐）
    expect(repo.update).toHaveBeenCalledWith(
      { id: fileId, uploadVersion },
      expect.objectContaining({ status: 'error', uploadStage: 'failed' }),
    );
  });

  it('marks error on commit when the remote receipt is empty even after retries are exhausted', async () => {
    mockedExistsSync.mockReturnValue(true);
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile());
    repo.findOneOrFail
      .mockResolvedValueOnce(makeFile({ uploadStage: 'uploading' }))
      .mockResolvedValueOnce(makeFile({ uploadStage: 'remote_committed', telegramFileId: '   ' }));
    // loadReceipt 返回空 file_id 的陈旧回执（版本匹配，校验 file_id 为空被拒）
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({ file_id: '', file_path: 'documents/x', uploadVersion }));
    const processor = makeProcessor(repo, { uploadFile: jest.fn() });

    await expect(processor.uploadToTelegram(makeJob(0))).rejects.toThrow('缺少有效 file_id');
    // 不允许任何 ready 置位
    const readyQueries = repo.query.mock.calls.filter((c) => String(c[0]).includes("status = $1"));
    expect(readyQueries).toHaveLength(0);
  });

  it('G3-13 aborts when the CAS to uploading misses (affected = 0)', async () => {
    mockedExistsSync.mockReturnValue(true);
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile());
    repo.update.mockResolvedValue({ affected: 0 }); // 升 uploading 未命中
    const processor = makeProcessor(repo, { uploadFile: jest.fn() });

    await processor.uploadToTelegram(makeJob(0));

    // 不应继续上传或提交
    expect(repo.update.mock.calls.some((c) => (c[1] as any)?.uploadStage === 'remote_committed')).toBe(false);
    expect(repo.query).not.toHaveBeenCalled();
  });

  it('G3-13 does not overwrite a newer uploadVersion when the remote commit update misses', async () => {
    mockedExistsSync.mockReturnValue(true);
    const repo = makeRepo();
    repo.findOne
      .mockResolvedValueOnce(makeFile())
      .mockResolvedValueOnce(makeFile({ uploadStage: 'remote_committed', telegramFileId: 'tg-id' }));
    repo.findOneOrFail.mockResolvedValueOnce(makeFile({ uploadStage: 'uploading' }));
    // 提交更新 0 命中（并发覆盖已把 uploadVersion 递增）→ 不得置 ready
    repo.update.mockResolvedValueOnce({ affected: 1 }).mockResolvedValueOnce({ affected: 0 });
    const telegram = { uploadFile: jest.fn().mockResolvedValue({ file_id: 'tg-id' }) };
    const processor = makeProcessor(repo, telegram);

    await expect(processor.uploadToTelegram(makeJob(0))).rejects.toThrow('条件未命中');
    expect(repo.query).not.toHaveBeenCalled();
  });

  it('G3-14 marks recoverable and keeps artifacts when retries exhaust with a remote receipt', async () => {
    mockedExistsSync.mockReturnValue(true);
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile());
    repo.findOneOrFail.mockResolvedValue(makeFile({ uploadStage: 'uploading' }));
    // 首次提交 update 抛错（DB 失败），loadReceipt 返回有效回执
    repo.update
      .mockResolvedValueOnce({ affected: 1 })          // CAS 升 uploading
      .mockRejectedValueOnce(new Error('db write failed')) // 提交失败
      .mockResolvedValueOnce({ affected: 1 });          // recoverable 标记
    mockedReadFile.mockResolvedValue(JSON.stringify({ file_id: 'tg-id', file_path: 'documents/x', uploadVersion }));
    const processor = makeProcessor(repo, { uploadFile: jest.fn() });

    await expect(processor.uploadToTelegram(makeJob(2))).rejects.toThrow('db write failed');

    // 应标记 recoverable 而非 error/failed，且不删除本地文件/回执
    const recoverableUpdate = repo.update.mock.calls.find((c) => (c[1] as any)?.uploadStage === 'recoverable');
    expect(recoverableUpdate).toBeDefined();
    expect((recoverableUpdate![1] as any).status).not.toBe('error');
  });
});
