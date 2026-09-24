import { existsSync, createReadStream } from 'fs';
import { readFile, writeFile } from 'fs/promises';
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
  // ready 置位经 `databaseQuery(repo.manager, ... RETURNING id)`：PG 下 UPDATE 返回
  // `[rows, rowCount]` 元组，必须走归一化路径才能正确判断「0 行命中」。
  const query = jest.fn().mockResolvedValue([{ id: fileId }]);
  return {
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    query,
    manager: { query },
  };
}

function makeProcessor(
  repo: ReturnType<typeof makeRepo>,
  telegram?: any,
  fileService?: any,
  accountUpload?: any,
) {
  return new FileUploadProcessor(
    repo as any,
    telegram || { uploadFile: jest.fn() } as any,
    fileService || {
      generateAndSaveThumbnail: jest.fn(),
      generateAndSaveVideoCover: jest.fn(),
      registerPrimaryTelegramSource: jest.fn(),
      triggerMirrorForFile: jest.fn(),
    } as any,
    undefined,
    accountUpload,
  );
}

function makeFileService() {
  return {
    generateAndSaveThumbnail: jest.fn(),
    generateAndSaveVideoCover: jest.fn(),
    registerPrimaryTelegramSource: jest.fn(),
    triggerMirrorForFile: jest.fn(),
  };
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
      'UPDATE files SET status = $1, "uploadFailureReason" = NULL WHERE id = $2 AND status IN ($3, $4) AND "uploadVersion" = $5 RETURNING id',
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
      'UPDATE files SET status = $1, "uploadFailureReason" = NULL WHERE id = $2 AND status IN ($3, $4) AND "uploadVersion" = $5 RETURNING id',
      ['ready', fileId, 'processing', 'error', uploadVersion],
    );
  });

  it('ready 条件未命中（0 行）时跳过收尾，不做定位登记与镜像触发', async () => {
    mockedExistsSync.mockReturnValue(true);
    const repo = makeRepo();
    // 0 行命中：并发覆盖导致 uploadVersion 已变
    repo.query.mockResolvedValueOnce([]);
    const fileService = {
      generateAndSaveThumbnail: jest.fn(),
      generateAndSaveVideoCover: jest.fn(),
      registerPrimaryTelegramSource: jest.fn(),
      triggerMirrorForFile: jest.fn(),
    };
    repo.findOne.mockResolvedValue(makeFile({ uploadStage: 'remote_committed', telegramFileId: 'tg-id' }));
    repo.findOneOrFail.mockResolvedValue(makeFile({ uploadStage: 'remote_committed', telegramFileId: 'tg-id' }));
    const processor = makeProcessor(repo, { uploadFile: jest.fn() }, fileService);

    await processor.uploadToTelegram(makeJob(0));

    expect(repo.update).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'ready' }),
    );
    expect(fileService.registerPrimaryTelegramSource).not.toHaveBeenCalled();
    expect(fileService.triggerMirrorForFile).not.toHaveBeenCalled();
  });

  it('正常成功路径：置 ready 条件 SQL 命中后必然登记主副本定位并触发镜像（收尾顺序回归）', async () => {
    mockedExistsSync.mockReturnValue(true);
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile());
    repo.findOneOrFail
      .mockResolvedValueOnce(makeFile({ uploadStage: 'uploading' }))
      .mockResolvedValueOnce(makeFile({ uploadStage: 'remote_committed', telegramFileId: 'tg-id' }));
    // 首次 loadReceipt 无回执 → 走真实上传；收尾阶段能读到带回执的定位信息
    mockedReadFile
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValue(JSON.stringify({
        file_id: 'tg-id',
        chat_id: '-100',
        message_id: '77',
        file_unique_id: 'UNIQ',
        uploadVersion,
      }));
    const telegram = { uploadFile: jest.fn().mockResolvedValue({ file_id: 'tg-id', file_path: '', file_size: 5 }) };
    const fileService = makeFileService();
    const processor = makeProcessor(repo, telegram, fileService);

    await processor.uploadToTelegram(makeJob(0));

    // 置 ready 条件 SQL 必须执行且命中（query 返回 1 行）
    expect(repo.query).toHaveBeenCalledWith(
      'UPDATE files SET status = $1, "uploadFailureReason" = NULL WHERE id = $2 AND status IN ($3, $4) AND "uploadVersion" = $5 RETURNING id',
      ['ready', fileId, 'processing', 'error', uploadVersion],
    );
    // 预热不再置状态后，这里是唯一置 ready 入口：命中后来源登记与镜像触发必然执行
    expect(fileService.registerPrimaryTelegramSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ file_id: 'tg-id', chat_id: '-100', message_id: '77' }),
      null,
    );
    expect(fileService.triggerMirrorForFile).toHaveBeenCalledWith(
      expect.anything(),
      { chat_id: '-100', message_id: '77' },
      null,
    );
    // 顺序红线：先置 ready（SQL 命中），再登记来源，最后触发镜像
    expect(repo.query.mock.invocationCallOrder[0])
      .toBeLessThan(fileService.registerPrimaryTelegramSource.mock.invocationCallOrder[0]);
    expect(fileService.registerPrimaryTelegramSource.mock.invocationCallOrder[0])
      .toBeLessThan(fileService.triggerMirrorForFile.mock.invocationCallOrder[0]);
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

describe('FileUploadProcessor 账号池上传选号', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCreateReadStream.mockReturnValue({} as any);
    mockedExistsSync.mockReturnValue(true);
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
  });

  it('非严格任务：池化上传优先，并把实际上传账号写入回执与定位登记', async () => {
    const repo = makeRepo();
    repo.findOne
      .mockResolvedValueOnce(makeFile())
      .mockResolvedValueOnce(makeFile({ uploadStage: 'remote_committed', telegramFileId: 'tg-pooled' }));
    repo.findOneOrFail
      .mockResolvedValueOnce(makeFile({ uploadStage: 'uploading' }))
      .mockResolvedValueOnce(makeFile({ uploadStage: 'remote_committed', telegramFileId: 'tg-pooled' }));
    // 首次 loadReceipt 无回执（触发上传）；提交阶段能读到池化回执
    mockedReadFile
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValue(JSON.stringify({
        file_id: 'tg-pooled',
        chat_id: '-100',
        message_id: '77',
        file_unique_id: 'UNIQ',
        sourceAccountId: 'acct-2',
        uploadVersion,
      }));
    const telegram = { uploadFile: jest.fn() };
    const accountUpload = {
      isActive: () => true,
      upload: jest.fn().mockResolvedValue({
        fileId: 'tg-pooled',
        fileSize: 5,
        chatId: '-100',
        messageId: '77',
        fileUniqueId: 'UNIQ',
        accountId: 'acct-2',
        selectionReason: 'stub',
      }),
    };
    const fileService = makeFileService();
    const processor = makeProcessor(repo, telegram, fileService, accountUpload);

    await processor.uploadToTelegram(makeJob(0));

    expect(accountUpload.upload).toHaveBeenCalledTimes(1);
    // 池化成功即不得再走默认单账号链路
    expect(telegram.uploadFile).not.toHaveBeenCalled();
    // 回执必须绑定实际上传账号（重启恢复提交时只有回执可依）
    const persisted = String((writeFile as jest.Mock).mock.calls.at(-1)?.[1] ?? '');
    expect(JSON.parse(persisted).sourceAccountId).toBe('acct-2');
    // 主副本定位登记必须传实际上传账号，否则回源会取错账号
    expect(fileService.registerPrimaryTelegramSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ file_id: 'tg-pooled', chat_id: '-100', message_id: '77' }),
      'acct-2',
    );
  });

  it('池化未成功（返回 null）时回退单账号链路', async () => {
    const repo = makeRepo();
    repo.findOne
      .mockResolvedValueOnce(makeFile())
      .mockResolvedValueOnce(makeFile({ uploadStage: 'remote_committed', telegramFileId: 'tg-default' }));
    repo.findOneOrFail
      .mockResolvedValueOnce(makeFile({ uploadStage: 'uploading' }))
      .mockResolvedValueOnce(makeFile({ uploadStage: 'remote_committed', telegramFileId: 'tg-default' }));
    const telegram = {
      uploadFile: jest.fn().mockResolvedValue({ file_id: 'tg-default', file_path: '', file_size: 5 }),
    };
    const accountUpload = { isActive: () => true, upload: jest.fn().mockResolvedValue(null) };
    const processor = makeProcessor(repo, telegram, makeFileService(), accountUpload);

    await processor.uploadToTelegram(makeJob(0));

    expect(accountUpload.upload).toHaveBeenCalledTimes(1);
    expect(telegram.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('严格无缓存任务：不走池化，保持单账号链路与本地媒体释放契约', async () => {
    const repo = makeRepo();
    repo.findOne
      .mockResolvedValueOnce(makeFile())
      .mockResolvedValueOnce(makeFile({ uploadStage: 'remote_committed', telegramFileId: 'tg-strict' }));
    repo.findOneOrFail
      .mockResolvedValueOnce(makeFile({ uploadStage: 'uploading' }))
      .mockResolvedValueOnce(makeFile({ uploadStage: 'remote_committed', telegramFileId: 'tg-strict' }));
    const telegram = {
      uploadFile: jest.fn().mockResolvedValue({
        file_id: 'tg-strict',
        file_path: '',
        file_size: 5,
        localCacheReleased: true,
      }),
      releaseLocalFile: jest.fn(),
    };
    const accountUpload = { isActive: () => true, upload: jest.fn() };
    const processor = makeProcessor(repo, telegram, makeFileService(), accountUpload);

    await processor.uploadToTelegram({
      data: { fileId, filePath, uploadVersion, strictDiskLease: true },
      attemptsMade: 0,
    } as any);

    // 严格任务必须保留 noCache 语义：既不池化，也不误触发 releaseLocalFile
    expect(accountUpload.upload).not.toHaveBeenCalled();
    expect(telegram.uploadFile).toHaveBeenCalledTimes(1);
    expect(telegram.uploadFile.mock.calls[0][4]).toMatchObject({ noCache: true });
    expect(telegram.releaseLocalFile).not.toHaveBeenCalled();
  });

  it('strictDiskLease=true：跳过池化（accountUpload.upload 不调用）且仍完成上传与来源登记', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(makeFile());
    repo.findOneOrFail
      .mockResolvedValueOnce(makeFile({ uploadStage: 'uploading' }))
      .mockResolvedValueOnce(makeFile({ uploadStage: 'remote_committed', telegramFileId: 'tg-strict' }));
    // 首次 loadReceipt 无回执 → 真实走单账号上传；收尾阶段能读到带回执的定位信息
    mockedReadFile
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValue(JSON.stringify({
        file_id: 'tg-strict',
        chat_id: '-200',
        message_id: '88',
        file_unique_id: 'UNIQ-S',
        localCacheReleased: true,
        uploadVersion,
      }));
    const telegram = {
      uploadFile: jest.fn().mockResolvedValue({
        file_id: 'tg-strict',
        file_path: '',
        file_size: 5,
        localCacheReleased: true,
      }),
      releaseLocalFile: jest.fn(),
    };
    const accountUpload = { isActive: () => true, upload: jest.fn() };
    const fileService = makeFileService();
    const processor = makeProcessor(repo, telegram, fileService, accountUpload);

    await processor.uploadToTelegram({
      data: { fileId, filePath, uploadVersion, strictDiskLease: true },
      attemptsMade: 0,
    } as any);

    // 严格任务按设计不池化：选号入口零调用
    expect(accountUpload.upload).not.toHaveBeenCalled();
    // 仍完成单账号上传（noCache 契约）
    expect(telegram.uploadFile).toHaveBeenCalledTimes(1);
    expect(telegram.uploadFile.mock.calls[0][4]).toMatchObject({ noCache: true });
    // 且收尾的置 ready → 来源登记照常执行（严格模式同样需要主副本定位）
    expect(fileService.registerPrimaryTelegramSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ file_id: 'tg-strict', chat_id: '-200', message_id: '88' }),
      null,
    );
  });
});
