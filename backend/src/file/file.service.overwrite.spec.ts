/**
 * 回归保护：内联覆盖（`applyOverwrite`）的版本递增与覆盖分支的旧副本失效。
 *
 * 事故形态（本用例存在的理由）：
 * - 镜像任务幂等键 = `(ruleId, ownerType, ownerId, sourceVersion)`，`sourceVersion` 取
 *   `File.uploadVersion`；内联覆盖若不递增版本，新内容会撞旧任务的幂等键、不产生新镜像任务，
 *   镜像群与下载长期停在旧内容上（`uploadToTelegram` 覆盖分支注释「覆盖上传递增
 *   uploadVersion」与实现由此对齐）；
 * - 副本行只有 `(ownerType, ownerId, accountId)` 唯一键、没有内容版本，覆盖必须让
 *   其它账号的旧副本整体作废（`invalidateByOwner`），否则 `listReady` 仍会回源到旧内容；
 * - 覆盖后必须继续使本地缓存与旧衍生图失效（C-05），版本递增不得改变该语义；
 * - 目标校验失败时不得留下版本递增的副作用（沿用既有抛错行为）。
 */
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { File } from '../common/entities/file.entity';
import { User } from '../common/entities/user.entity';
import { FileService } from './file.service';

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '99999999-9999-4999-8999-999999999999';
const targetFileId = '22222222-2222-4222-8222-222222222222';

function makeUser(id: string): User {
  return { id } as User;
}

/** 覆盖目标（pre-validated target）与事务内锁定行（locked）共用同一构造 */
function makeFile(overrides: Partial<File> = {}): File {
  return Object.assign(new File(), {
    id: targetFileId,
    filename: 'old-tg-id',
    originalName: '旧文件.pdf',
    mimeType: 'application/pdf',
    size: 100,
    telegramFileId: 'old-tg-id',
    telegramFilePath: 'old/path',
    thumbnailPath: 'old-thumb.webp',
    folderId: null,
    uploaderId: ownerId,
    isDeleted: false,
    status: 'ready',
    uploadVersion: 1,
    ...overrides,
  });
}

function makeMulterFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: '新文件.pdf',
    encoding: '7bit',
    mimetype: 'application/pdf',
    buffer: Buffer.from('hello'),
    size: 5,
    destination: '',
    filename: '新文件.pdf',
    path: '',
    stream: null as never,
    ...overrides,
  };
}

type OverwriteParams = Parameters<FileService['applyOverwrite']>[1];

function overwriteParams(overrides: Partial<OverwriteParams> = {}): OverwriteParams {
  return {
    telegramFileId: 'new-tg-id',
    telegramFilePath: 'new/path',
    filename: 'new-tg-id',
    originalName: '新文件.pdf',
    size: 200,
    mimeType: 'application/pdf',
    user: makeUser(ownerId),
    ...overrides,
  };
}

/**
 * 以最小桩直接构造 `FileService`：
 * 前 17 个必需依赖中只有被触达的给真实现，可选依赖按构造顺序传
 * `null, null, copiesStub, null`（fileCopies 供覆盖分支失效用例断言）。
 */
function setup(options: { locked?: File; target?: File } = {}) {
  const lockedRow = options.locked ?? makeFile();
  const targetRow = options.target ?? makeFile();

  const txUpdate = jest.fn(async () => ({ affected: 1 }));
  const txSave = jest.fn(async (entity: File) => entity);
  const txRepo = {
    findOne: jest.fn(async () => lockedRow),
    update: txUpdate,
    save: txSave,
  };
  const manager: { getRepository: jest.Mock } = { getRepository: jest.fn(() => txRepo) };
  const fileRepository = {
    findOne: jest.fn(async () => targetRow),
    update: jest.fn(async () => ({ affected: 1 })),
    manager: {
      // 直接以回调传入的 manager 执行，模拟「单事务」语义
      transaction: jest.fn(async (run: (m: typeof manager) => Promise<unknown>) => run(manager)),
    },
  };
  const fileCacheService = { invalidate: jest.fn(async () => undefined) };
  const thumbnailService = { deleteThumbnailsForFileId: jest.fn(async () => undefined) };
  const auditService = { log: jest.fn() };
  const namespaceService = { acquire: jest.fn(async () => undefined) };
  const copies = {
    invalidateByOwner: jest.fn(async () => 0),
    upsertReady: jest.fn(async (input: Record<string, unknown>) => ({ ...input, id: 'copy-1' })),
  };
  const telegramService = {
    uploadFile: jest.fn(async () => ({
      file_id: 'new-tg-id',
      file_path: 'new/path',
      message_id: '42',
      chat_id: '-100777',
      file_unique_id: 'UNIQ-new',
    })),
  };
  const configService = { get: jest.fn(() => undefined) };
  const uploadConfig = { maxFileSizeBytes: 10 * 1024 * 1024 };

  const service = new FileService(
    fileRepository as never,   // 1  fileRepository
    {} as never,               // 2  folderRepository
    {} as never,               // 3  accessLogRepository
    {} as never,               // 4  shareAuditRepository
    {} as never,               // 5  shareLinkRepository
    telegramService as never,  // 6  telegramService
    configService as never,    // 7  configService
    {} as never,               // 8  jwtService
    {} as never,               // 9  configCacheService
    {} as never,               // 10 uploadJobService
    auditService as never,     // 11 auditService
    fileCacheService as never, // 12 fileCacheService
    thumbnailService as never, // 13 thumbnailService
    namespaceService as never, // 14 namespaceService
    {} as never,               // 15 fileUploadQueue
    {} as never,               // 16 accessControl
    uploadConfig as never,     // 17 uploadConfig
    null,                      // 18 accountAwareDownload（可选）
    null,                      // 19 accountAwareUpload（可选）
    copies as never,           // 20 fileCopies（可选）
    null,                      // 21 mirrorTrigger（可选）
  );
  return {
    service,
    fileRepository,
    txUpdate,
    txSave,
    fileCacheService,
    thumbnailService,
    auditService,
    namespaceService,
    copies,
    telegramService,
  };
}

describe('FileService.applyOverwrite（覆盖上传递增 uploadVersion）', () => {
  it('覆盖时 update 载荷包含递增后的 uploadVersion，返回值同步为新版本（旧版本 1 → 2）', async () => {
    const ctx = setup({ locked: makeFile({ uploadVersion: 1 }) });
    const target = makeFile({ uploadVersion: 1 });

    const result = await ctx.service.applyOverwrite(target, overwriteParams());

    expect(ctx.txUpdate).toHaveBeenCalledWith(targetFileId, expect.objectContaining({
      telegramFileId: 'new-tg-id',
      originalName: '新文件.pdf',
      uploadVersion: 2,
    }));
    // 返回值必须同步新版本：调用方（主副本登记 / 镜像触发）直接读它作为 sourceVersion
    expect(result.uploadVersion).toBe(2);
  });

  it('版本递增基于悲观锁内的当前版本，而非外部陈旧对象（旧版本 3 → 4）', async () => {
    const ctx = setup({ locked: makeFile({ uploadVersion: 3 }) });
    // 外部 target 的版本刻意陈旧：递增必须以锁内行（locked）为准，否则并发覆盖会丢版本
    const target = makeFile({ uploadVersion: 1 });

    const result = await ctx.service.applyOverwrite(target, overwriteParams());

    expect(ctx.txUpdate).toHaveBeenCalledWith(targetFileId, expect.objectContaining({
      uploadVersion: 4,
    }));
    expect(result.uploadVersion).toBe(4);
  });

  it('覆盖后既有失效语义不变：本地缓存与旧衍生图仍被清理', async () => {
    const ctx = setup();

    await ctx.service.applyOverwrite(makeFile(), overwriteParams());

    expect(ctx.fileCacheService.invalidate).toHaveBeenCalledWith(targetFileId);
    expect(ctx.thumbnailService.deleteThumbnailsForFileId).toHaveBeenCalledWith(targetFileId);
  });

  it('覆盖目标校验失败（uploaderId 不符）时不递增版本（沿用既有抛错行为）', async () => {
    const ctx = setup({ locked: makeFile({ uploaderId: otherUserId }) });

    await expect(ctx.service.applyOverwrite(makeFile(), overwriteParams()))
      .rejects.toThrow(BadRequestException);
    expect(ctx.txUpdate).not.toHaveBeenCalled();
  });

  it('覆盖目标校验失败（目录不符）时不递增版本（沿用既有抛错行为）', async () => {
    const ctx = setup({ locked: makeFile({ folderId: 'other-folder' }) });

    await expect(ctx.service.applyOverwrite(makeFile(), overwriteParams()))
      .rejects.toThrow(BadRequestException);
    expect(ctx.txUpdate).not.toHaveBeenCalled();
  });

  it('覆盖目标校验失败（processing）时不递增版本（沿用既有抛错行为）', async () => {
    const ctx = setup({ locked: makeFile({ status: 'processing' }) });

    await expect(ctx.service.applyOverwrite(makeFile(), overwriteParams()))
      .rejects.toThrow(BadRequestException);
    expect(ctx.txUpdate).not.toHaveBeenCalled();
  });
});

describe('FileService 覆盖分支接入旧副本失效（invalidateByOwner）', () => {
  it('uploadToTelegram 覆盖分支：登记主副本前先失效其它账号旧副本（保留本次上传账号）', async () => {
    const ctx = setup({ locked: makeFile({ uploadVersion: 1 }) });

    const result = await (ctx.service as unknown as {
      uploadToTelegram: (
        file: Express.Multer.File,
        user: User,
        originalName: string,
        abortSignal?: AbortSignal,
        folderId?: string | null,
        overwriteFileId?: string,
      ) => Promise<File>;
    }).uploadToTelegram(makeMulterFile(), makeUser(ownerId), '新文件.pdf', undefined, null, targetFileId);

    // exceptAccountId 与 registerPrimaryTelegramSource 写副本行的账号口径一致
    // （无 TELEGRAM_BOT_TOKEN 时兜底 'default'），避免误删刚写入的主副本行
    expect(ctx.copies.invalidateByOwner).toHaveBeenCalledWith('file', targetFileId, 'default');
    expect(ctx.copies.upsertReady).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: 'file',
      ownerId: targetFileId,
      accountId: 'default',
      telegramFileId: 'new-tg-id',
    }));
    // 顺序红线：必须先失效旧副本、后登记主副本，反过来会把旧行留到下次回源
    expect(ctx.copies.invalidateByOwner.mock.invocationCallOrder[0])
      .toBeLessThan(ctx.copies.upsertReady.mock.invocationCallOrder[0]);
    // 覆盖结果仍保持原 id 与新版本
    expect(result.id).toBe(targetFileId);
    expect(result.uploadVersion).toBe(2);
  });

  it('createProcessingFile 覆盖分支：事务前整体失效旧副本（不带 except，新主副本由 Worker 重写）', async () => {
    const ctx = setup({ locked: makeFile({ uploadVersion: 1 }) });

    const result = await ctx.service.createProcessingFile(
      makeMulterFile(),
      '新文件.pdf',
      makeUser(ownerId),
      undefined,
      true,
      null,
      targetFileId,
      { deferCachePrewarm: true },
    );

    // 此刻还不知道将来由哪个账号上传，必须整体失效（不带 exceptAccountId）
    expect(ctx.copies.invalidateByOwner).toHaveBeenCalledWith('file', targetFileId);
    expect(ctx.fileCacheService.invalidate).toHaveBeenCalledWith(targetFileId);
    expect(ctx.thumbnailService.deleteThumbnailsForFileId).toHaveBeenCalledWith(targetFileId);
    // 失效必须发生在事务（写入 processing 新版本）之前
    expect(ctx.copies.invalidateByOwner.mock.invocationCallOrder[0])
      .toBeLessThan(ctx.fileRepository.manager.transaction.mock.invocationCallOrder[0]);
    // 既有 G2-05 语义不受影响：版本照常递增、状态进入 processing
    expect(result.status).toBe('processing');
    expect(result.uploadVersion).toBe(2);
  });
});
