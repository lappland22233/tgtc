import { Logger } from '@nestjs/common';
import { FileService } from './file.service';

/**
 * 非 TG 远端对象清理的共享引用检查（Spec：覆盖提交后/永久删除后，
 * 无其他 File 行引用同一 (storageAccountId, storageObjectRef) 才删；TG 维持不删）。
 */
function makeService(opts: { sharedCount?: number } = {}) {
  const service = Object.create(FileService.prototype) as FileService;
  const count = jest.fn().mockResolvedValue(opts.sharedCount ?? 0);
  const deleteRemoteObject = jest.fn().mockResolvedValue(true);
  Object.assign(service, {
    logger: new Logger('FileServiceCleanupSpec'),
    fileRepository: { count },
    storageRouter: { deleteRemoteObject },
  });
  return { service, count, deleteRemoteObject };
}

const ref = {
  storageBackend: 's3',
  storageAccountId: 'acc-1',
  storageObjectRef: 'prefix/uuid-file.bin',
};

describe('cleanupNonTelegramObject 共享引用检查', () => {
  it('无其他引用：执行远端删除', async () => {
    const { service, count, deleteRemoteObject } = makeService({ sharedCount: 0 });
    await service.cleanupNonTelegramObject(ref);
    expect(count).toHaveBeenCalledWith({
      where: { storageAccountId: 'acc-1', storageObjectRef: 'prefix/uuid-file.bin' },
    });
    expect(deleteRemoteObject).toHaveBeenCalledWith('s3', 'acc-1', 'prefix/uuid-file.bin');
  });

  it('仍被其他记录共享（引用复制）：跳过删除，绝不触碰远端', async () => {
    const { service, deleteRemoteObject } = makeService({ sharedCount: 2 });
    await service.cleanupNonTelegramObject(ref);
    expect(deleteRemoteObject).not.toHaveBeenCalled();
  });

  it('TG 对象维持不删现状（telegramFileId 可能被多条记录共享）', async () => {
    const { service, count, deleteRemoteObject } = makeService();
    await service.cleanupNonTelegramObject({
      storageBackend: 'telegram',
      storageAccountId: null,
      storageObjectRef: null,
    });
    expect(count).not.toHaveBeenCalled();
    expect(deleteRemoteObject).not.toHaveBeenCalled();
  });

  it('引用缺失/路由未装配：安全跳过', async () => {
    const { service, deleteRemoteObject } = makeService();
    await service.cleanupNonTelegramObject({ storageBackend: 's3', storageAccountId: '', storageObjectRef: 'x' });
    await service.cleanupNonTelegramObject({ storageBackend: 's3', storageAccountId: 'a', storageObjectRef: '  ' });
    expect(deleteRemoteObject).not.toHaveBeenCalled();

    const noRouter = Object.create(FileService.prototype) as FileService;
    Object.assign(noRouter, { logger: new Logger('x'), storageRouter: null, fileRepository: { count: jest.fn() } });
    await noRouter.cleanupNonTelegramObject(ref);
  });

  it('远端删除失败/计数异常：best-effort 吞掉，绝不影响主流程结论', async () => {
    const { service, deleteRemoteObject } = makeService();
    deleteRemoteObject.mockResolvedValue(false);
    await expect(service.cleanupNonTelegramObject(ref)).resolves.toBeUndefined();

    const broken = Object.create(FileService.prototype) as FileService;
    Object.assign(broken, {
      logger: new Logger('x'),
      storageRouter: { deleteRemoteObject: jest.fn() },
      fileRepository: { count: jest.fn().mockRejectedValue(new Error('db down')) },
    });
    await expect(broken.cleanupNonTelegramObject(ref)).resolves.toBeUndefined();
  });

  it('webdav/gdrive 后端同样适用共享检查', async () => {
    for (const backend of ['webdav', 'gdrive']) {
      const { service, deleteRemoteObject } = makeService();
      await service.cleanupNonTelegramObject({ ...ref, storageBackend: backend });
      expect(deleteRemoteObject).toHaveBeenCalledWith(backend, 'acc-1', 'prefix/uuid-file.bin');
    }
  });
});