/**
 * B-02 回归保护：覆盖上传失败必须回滚原内容引用。
 *
 * 事故形态（本用例存在的理由）：覆盖事务先把 telegramFileId/filename 置为 tempId 占位、
 * telegramFilePath 清空；新内容上传失败/取消/重试耗尽时旧实现只置 status=error，
 * 无任何路径恢复旧引用 —— 用户原文件永久不可下载，旧远端对象成孤儿，
 * 只有审计日志的 oldTelegramFileId 留有线索。
 */
import 'reflect-metadata';
import { File } from '../common/entities/file.entity';
import { FileService } from './file.service';

const fileId = '22222222-2222-4222-8222-222222222222';
const uploadVersion = 2;

const PREV = {
  filename: 'old-tg-id',
  telegramFileId: 'old-tg-id',
  telegramFilePath: 'old/path',
  storageBackend: 'telegram',
  storageAccountId: null,
  storageObjectRef: null,
  size: 100,
  mimeType: 'application/pdf',
  originalName: '旧文件.pdf',
  thumbnailPath: 'old-thumb.webp',
  status: 'ready',
  uploadStage: 'committed',
};

/** 覆盖后的占位行：引用已被 tempId 取代，快照仍在 */
function makeProcessingRow(snapshot: string | null): Partial<File> {
  return {
    id: fileId,
    uploadVersion,
    status: 'processing',
    filename: 'temp-uuid',
    telegramFileId: 'temp-uuid',
    telegramFilePath: '',
    originalName: '新文件.pdf',
    size: 200,
    overwriteSnapshot: snapshot,
  };
}

function makeService(row: Partial<File> | null, updateAffected = 1) {
  const update = jest.fn().mockResolvedValue({ affected: updateAffected });
  const repo = { findOne: jest.fn().mockResolvedValue(row), update };
  const manager = { getRepository: jest.fn(() => repo) };
  const service = Object.create(FileService.prototype) as FileService;
  const directUpdate = jest.fn().mockResolvedValue({ affected: 1 });
  (service as any).fileRepository = {
    manager: { transaction: jest.fn(async (fn: any) => fn(manager)) },
    update: directUpdate,
  };
  (service as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  (service as any).namespaceService = { release: jest.fn().mockResolvedValue(undefined) };
  return { service, repo, update, directUpdate };
}

describe('覆盖上传失败回滚原内容引用（B-02）', () => {
  it('markProcessingFileFailed 有快照时恢复原引用，不得把原文件标 error', async () => {
    const { service, update, directUpdate } = makeService(makeProcessingRow(JSON.stringify(PREV)));

    await service.markProcessingFileFailed(fileId, uploadVersion);

    expect(update).toHaveBeenCalledWith(
      { id: fileId, uploadVersion, status: 'processing' },
      expect.objectContaining({
        telegramFileId: 'old-tg-id',
        filename: 'old-tg-id',
        telegramFilePath: 'old/path',
        size: 100,
        originalName: '旧文件.pdf',
        thumbnailPath: 'old-thumb.webp',
        status: 'ready',
        uploadStage: 'committed',
        overwriteSnapshot: null,
      }),
    );
    // 不得再走「标记 error」分支
    expect(directUpdate).not.toHaveBeenCalled();
  });

  it('无快照（新建上传）时保持原有标记 error 行为', async () => {
    const { service, update, directUpdate } = makeService(makeProcessingRow(null));

    await service.markProcessingFileFailed(fileId, uploadVersion);

    expect(update).not.toHaveBeenCalled();
    expect(directUpdate).toHaveBeenCalledWith(
      { id: fileId, uploadVersion, status: 'processing' },
      expect.objectContaining({ status: 'error', uploadStage: 'failed' }),
    );
  });

  it('softDeleteProcessingFile 有快照时不得软删用户原文件，也不得释放名称占用', async () => {
    const { service, update } = makeService(makeProcessingRow(JSON.stringify(PREV)));

    await service.softDeleteProcessingFile(fileId, uploadVersion);

    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ telegramFileId: 'old-tg-id' }),
    );
    const softDeleteCall = update.mock.calls.find(([, patch]) => (patch as any).isDeleted === true);
    expect(softDeleteCall).toBeUndefined();
    expect((service as any).namespaceService.release).not.toHaveBeenCalled();
  });

  it('回滚守卫必须带 status=processing：已 ready 的文件不得被迟到的失败路径回滚', async () => {
    const { service, repo } = makeService(makeProcessingRow(JSON.stringify(PREV)));

    await service.rollbackOverwriteIfSnapshot(fileId, uploadVersion);

    expect(repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: fileId, uploadVersion, status: 'processing' } }),
    );
  });

  it('快照损坏时放弃回滚并回落到标记 error，不得抛错中断失败处理', async () => {
    const { service, directUpdate } = makeService(makeProcessingRow('{not-json'));

    await expect(service.markProcessingFileFailed(fileId, uploadVersion)).resolves.toBeUndefined();

    expect(directUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('条件更新 0 行命中（并发变更）时报告未回滚', async () => {
    const { service } = makeService(makeProcessingRow(JSON.stringify(PREV)), 0);

    await expect(service.rollbackOverwriteIfSnapshot(fileId, uploadVersion)).resolves.toBe(false);
  });

  it('非 TG 后端的覆盖同样回滚 storageObjectRef/storageAccountId/storageBackend', async () => {
    const prev = {
      ...PREV,
      storageBackend: 's3',
      storageAccountId: 'acc-1',
      storageObjectRef: 'prefix/old.pdf',
      telegramFileId: null,
      filename: '旧文件.pdf',
    };
    const { service, update } = makeService(makeProcessingRow(JSON.stringify(prev)));

    await service.rollbackOverwriteIfSnapshot(fileId, uploadVersion);

    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        storageBackend: 's3',
        storageAccountId: 'acc-1',
        storageObjectRef: 'prefix/old.pdf',
      }),
    );
  });
});