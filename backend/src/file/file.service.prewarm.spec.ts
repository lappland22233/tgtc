/**
 * 回归保护：`startCachePrewarm` 只写缓存字节，不得写任何数据库状态。
 *
 * 事故形态（本用例存在的理由）：
 * - 预热成功后曾把文件直接置 `ready`（条件更新 `status='processing'`），而
 *   `FileUploadProcessor` 收尾的置 ready 条件更新要求 `status IN ('processing','error')`，
 *   命中 0 行后 `return`，跳过来源定位登记与镜像触发；文件还会在远端提交前就变为
 *   可下载（可能命中无效引用）。
 * - 修复后：预热成功只写缓存目录 + 记「文件缓存就绪」日志；置 ready 唯一入口是
 *   Worker 收尾的条件更新。
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import { FileService } from './file.service';

// 预热按 `fs.existsSync` 判断源文件是否可用，必须替换为可控桩（真实路径依赖磁盘状态）。
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
}));

const mockedExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;

const fileId = '33333333-3333-4333-8333-333333333333';
const sourcePath = 'C:/tmp/pending/prewarm-source.bin';

/**
 * 以最小桩直接构造 `FileService`（与 file.service.overwrite.spec.ts 同法）：
 * 前 17 个必需依赖中只有 fileCacheService / fileRepository / configService 被触达，
 * 可选依赖按构造顺序传 `null, null, null, null`。
 */
function setup(options: { noCacheMode?: boolean; cacheError?: Error } = {}) {
  const fileRepository = {
    update: jest.fn(async () => ({ affected: 1 })),
  };
  const fileCacheService = {
    isNoCacheMode: jest.fn(() => options.noCacheMode === true),
    cacheFileFromPath: options.cacheError
      ? jest.fn(async () => {
          throw options.cacheError;
        })
      : jest.fn(async () => undefined),
  };
  const configService = { get: jest.fn(() => undefined) };

  const service = new FileService(
    fileRepository as never,   // 1  fileRepository
    {} as never,               // 2  folderRepository
    {} as never,               // 3  accessLogRepository
    {} as never,               // 4  shareAuditRepository
    {} as never,               // 5  shareLinkRepository
    {} as never,               // 6  telegramService
    configService as never,    // 7  configService
    {} as never,               // 8  jwtService
    {} as never,               // 9  configCacheService
    {} as never,               // 10 uploadJobService
    {} as never,               // 11 auditService
    fileCacheService as never, // 12 fileCacheService
    {} as never,               // 13 thumbnailService
    {} as never,               // 14 namespaceService
    {} as never,               // 15 fileUploadQueue
    {} as never,               // 16 accessControl
    {} as never,               // 17 uploadConfig
    null,                      // 18 accountAwareDownload（可选）
    null,                      // 19 accountAwareUpload（可选）
    null,                      // 20 fileCopies（可选）
    null,                      // 21 mirrorTrigger（可选）
  );
  return { service, fileRepository, fileCacheService };
}

describe('FileService.startCachePrewarm（预热不得写状态）', () => {
  beforeEach(() => {
    mockedExistsSync.mockReset();
    mockedExistsSync.mockReturnValue(false); // 默认源文件不存在
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('预热成功：只写缓存目录，不写任何数据库状态（update 零调用）', async () => {
    mockedExistsSync.mockReturnValue(true);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const ctx = setup();

    await ctx.service.startCachePrewarm({ id: fileId, uploadVersion: 3 }, sourcePath, 128);

    // 字节侧行为不变：仍按 id/路径/大小写入缓存目录
    expect(ctx.fileCacheService.cacheFileFromPath).toHaveBeenCalledWith(fileId, sourcePath, 128);
    // 核心回归：预热成功后不得置 ready / 写任何状态——置 ready 唯一入口是 FileUploadProcessor 收尾
    expect(ctx.fileRepository.update).not.toHaveBeenCalled();
    // 可观测性保留：缓存就绪仍记日志，且只带 id（不再输出无意义的 v<version>）
    expect(logSpy).toHaveBeenCalledWith(`文件缓存就绪: ${fileId}`);
  });

  it('isNoCacheMode() 为真：直接 resolve，不写缓存、不写库', async () => {
    const ctx = setup({ noCacheMode: true });

    await expect(
      ctx.service.startCachePrewarm({ id: fileId, uploadVersion: 1 }, sourcePath, 10),
    ).resolves.toBeUndefined();

    expect(ctx.fileCacheService.cacheFileFromPath).not.toHaveBeenCalled();
    expect(ctx.fileRepository.update).not.toHaveBeenCalled();
  });

  it('sourcePath 为空：直接 resolve，不写缓存、不写库', async () => {
    const ctx = setup();

    await expect(
      ctx.service.startCachePrewarm({ id: fileId, uploadVersion: 1 }),
    ).resolves.toBeUndefined();

    expect(ctx.fileCacheService.cacheFileFromPath).not.toHaveBeenCalled();
    expect(ctx.fileRepository.update).not.toHaveBeenCalled();
  });

  it('源文件不存在：直接 resolve，不写缓存、不写库', async () => {
    mockedExistsSync.mockReturnValue(false);
    const ctx = setup();

    await expect(
      ctx.service.startCachePrewarm({ id: fileId, uploadVersion: 1 }, sourcePath, 10),
    ).resolves.toBeUndefined();

    expect(ctx.fileCacheService.cacheFileFromPath).not.toHaveBeenCalled();
    expect(ctx.fileRepository.update).not.toHaveBeenCalled();
  });

  it('cacheFileFromPath 失败：方法仍 resolve（不抛错），且不写任何状态', async () => {
    mockedExistsSync.mockReturnValue(true);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const ctx = setup({ cacheError: new Error('disk full') });

    await expect(
      ctx.service.startCachePrewarm({ id: fileId, uploadVersion: 1 }, sourcePath, 10),
    ).resolves.toBeUndefined();

    // 预热失败只 warn 不抛错（缓存未热只影响首次下载速度，不阻断上传链路）
    expect(ctx.fileRepository.update).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('缓存预热失败'));
  });
});
