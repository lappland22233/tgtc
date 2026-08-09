jest.mock('file-type', () => ({
  fileTypeFromBuffer: jest.fn().mockResolvedValue(undefined),
}), { virtual: true });

import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FileService } from './file.service';
import { ChunkUploadService } from './chunk-upload.service';
import { InitChunkUploadDto } from './chunk-upload.dto';
import { File } from '../common/entities/file.entity';
import { Folder } from '../common/entities/folder.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { TelegramService } from '../telegram/telegram.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { RateLimitService } from '../common/services/rate-limit.service';
import { AuditService } from '../common/services/audit.service';
import { UploadJobService } from './upload-job.service';
import { FileCacheService } from './file-cache.service';
import { QUEUE_NAMES } from '../jobs/bull-queue.module';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '../common/entities/user.entity';

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '99999999-9999-4999-8999-999999999999';
const targetFileId = '22222222-2222-4222-8222-222222222222';
const folderId = '33333333-3333-4333-8333-333333333333';

function makeUser(id: string): User {
  return { id } as User;
}

function makeTargetFile(overrides: Partial<File> = {}): File {
  return Object.assign(new File(), {
    id: targetFileId,
    filename: 'old-tg-file-id',
    originalName: '旧文件.png',
    mimeType: 'image/png',
    size: 100,
    telegramFileId: 'old-tg-file-id',
    telegramFilePath: 'old/path',
    thumbnailPath: '22222222.webp',
    folderId: null,
    uploaderId: ownerId,
    isDeleted: false,
    status: 'ready',
    ...overrides,
  });
}

function makeMulterFile(): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: '新文件.png',
    encoding: '7bit',
    mimetype: 'image/png',
    buffer: Buffer.from('hello'),
    size: 5,
    destination: '',
    filename: '新文件.png',
    path: '',
    stream: null as any,
  };
}

describe('FileService - assertOverwriteTarget', () => {
  let service: FileService;
  let fileRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock; update: jest.Mock; manager: any };
  let audit: { log: jest.Mock; logAwait: jest.Mock };
  let fileCache: { invalidate: jest.Mock; cacheFileFromPath: jest.Mock; isNoCacheMode: jest.Mock };

  beforeEach(async () => {
    fileRepo = {
      findOne: jest.fn(),
      create: jest.fn((data: Partial<File>) => Object.assign(new File(), data)),
      save: jest.fn(async (entity: File) => entity),
      update: jest.fn().mockResolvedValue(undefined),
      manager: { transaction: jest.fn(), query: jest.fn() },
    };
    audit = { log: jest.fn(), logAwait: jest.fn() };
    fileCache = { invalidate: jest.fn(), cacheFileFromPath: jest.fn().mockResolvedValue(undefined), isNoCacheMode: jest.fn().mockReturnValue(false) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        FileService,
        { provide: getRepositoryToken(File), useValue: fileRepo },
        { provide: getRepositoryToken(Folder), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(FileAccessLog), useValue: {} },
        { provide: getRepositoryToken(BannedIP), useValue: {} },
        { provide: getRepositoryToken(ShareAudit), useValue: {} },
        { provide: TelegramService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
        { provide: JwtService, useValue: {} },
        { provide: ConfigCacheService, useValue: { get: jest.fn(async (_k: string, fb: string) => fb) } },
        { provide: RateLimitService, useValue: {} },
        { provide: UploadJobService, useValue: {} },
        { provide: AuditService, useValue: audit },
        { provide: FileCacheService, useValue: fileCache },
        { provide: getQueueToken(QUEUE_NAMES.FILE_UPLOAD), useValue: { add: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(FileService);
  });

  it('目标不存在（含已软删：isDeleted=false 条件查不到）抛 NotFoundException', async () => {
    fileRepo.findOne.mockResolvedValue(null);
    await expect(service.assertOverwriteTarget(targetFileId, makeUser(ownerId), null))
      .rejects.toThrow(NotFoundException);
    // 查询必须携带 isDeleted=false 条件
    expect(fileRepo.findOne).toHaveBeenCalledWith({
      where: { id: targetFileId, isDeleted: false },
    });
  });

  it('目标非当前用户所有抛 BadRequestException（不走 admin 放行）', async () => {
    fileRepo.findOne.mockResolvedValue(makeTargetFile({ uploaderId: otherUserId }));
    await expect(service.assertOverwriteTarget(targetFileId, makeUser(ownerId), null))
      .rejects.toThrow(BadRequestException);
  });

  it('folderId 不一致抛 BadRequestException', async () => {
    fileRepo.findOne.mockResolvedValue(makeTargetFile({ folderId }));
    await expect(service.assertOverwriteTarget(targetFileId, makeUser(ownerId), null))
      .rejects.toThrow(BadRequestException);
  });

  it('目标 status=processing 抛 BadRequestException（防与在途 Bull job 竞写）', async () => {
    fileRepo.findOne.mockResolvedValue(makeTargetFile({ status: 'processing' }));
    await expect(service.assertOverwriteTarget(targetFileId, makeUser(ownerId), null))
      .rejects.toThrow(BadRequestException);
  });

  it('null 对 null 目录匹配时成功返回旧实体', async () => {
    const target = makeTargetFile({ folderId: null });
    fileRepo.findOne.mockResolvedValue(target);
    const result = await service.assertOverwriteTarget(targetFileId, makeUser(ownerId), null);
    expect(result).toBe(target);
  });

  it('同一文件夹内匹配成功返回旧实体', async () => {
    const target = makeTargetFile({ folderId });
    fileRepo.findOne.mockResolvedValue(target);
    const result = await service.assertOverwriteTarget(targetFileId, makeUser(ownerId), folderId);
    expect(result).toBe(target);
  });
});

describe('FileService - createProcessingFile 覆盖分支', () => {
  let service: FileService;
  let fileRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock; update: jest.Mock; manager: any };
  let audit: { log: jest.Mock; logAwait: jest.Mock };
  let fileCache: { invalidate: jest.Mock; cacheFileFromPath: jest.Mock; isNoCacheMode: jest.Mock };

  beforeEach(async () => {
    fileRepo = {
      findOne: jest.fn(),
      create: jest.fn((data: Partial<File>) => Object.assign(new File(), data)),
      save: jest.fn(async (entity: File) => entity),
      update: jest.fn().mockResolvedValue(undefined),
      manager: { transaction: jest.fn(), query: jest.fn() },
    };
    audit = { log: jest.fn(), logAwait: jest.fn() };
    fileCache = { invalidate: jest.fn(), cacheFileFromPath: jest.fn().mockResolvedValue(undefined), isNoCacheMode: jest.fn().mockReturnValue(false) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        FileService,
        { provide: getRepositoryToken(File), useValue: fileRepo },
        { provide: getRepositoryToken(Folder), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(FileAccessLog), useValue: {} },
        { provide: getRepositoryToken(BannedIP), useValue: {} },
        { provide: getRepositoryToken(ShareAudit), useValue: {} },
        { provide: TelegramService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
        { provide: JwtService, useValue: {} },
        { provide: ConfigCacheService, useValue: { get: jest.fn(async (_k: string, fb: string) => fb) } },
        { provide: RateLimitService, useValue: {} },
        { provide: UploadJobService, useValue: {} },
        { provide: AuditService, useValue: audit },
        { provide: FileCacheService, useValue: fileCache },
        { provide: getQueueToken(QUEUE_NAMES.FILE_UPLOAD), useValue: { add: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(FileService);
  });

  it('覆盖成功：复用旧记录 id，status 置 processing，tempId 占位，不新建记录不新增标签', async () => {
    const target = makeTargetFile();
    fileRepo.findOne.mockResolvedValue(target);

    const result = await service.createProcessingFile(
      makeMulterFile(),
      '新文件.png',
      makeUser(ownerId),
      ['tag-1'],        // 覆盖分支必须忽略 tagIds
      true,             // skipTypeCheck
      null,
      targetFileId,     // overwriteFileId
    );

    // 关键：id 不变（in-place）
    expect(result.id).toBe(targetFileId);
    expect(result.status).toBe('processing');
    expect(result.originalName).toBe('新文件.png');
    expect(result.size).toBe(5);
    // tempId 占位：filename 与 telegramFileId 一致且不再是旧 TG 引用
    expect(result.filename).toBe(result.telegramFileId);
    expect(result.telegramFileId).not.toBe('old-tg-file-id');
    expect(result.telegramFilePath).toBe('');
    // 复用旧记录：未创建新实体
    expect(fileRepo.create).not.toHaveBeenCalled();
    expect(fileRepo.save).toHaveBeenCalledWith(target);
    // 覆盖不新增标签（未触碰 manager/标签插入）
    expect(fileRepo.manager.transaction).not.toHaveBeenCalled();
    expect(fileRepo.manager.query).not.toHaveBeenCalled();
    // 审计覆盖意图
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'file_overwrite',
        resourceId: targetFileId,
        metadata: expect.objectContaining({ oldTelegramFileId: 'old-tg-file-id', status: 'processing' }),
      }),
    );
    expect(audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'file_upload' }));
  });

  it('覆盖目标不存在时降级为原新建逻辑（不丢已传字节），审计 fallback', async () => {
    fileRepo.findOne.mockResolvedValue(null); // assertOverwriteTarget → NotFoundException

    const result = await service.createProcessingFile(
      makeMulterFile(),
      '新文件.png',
      makeUser(ownerId),
      undefined,
      true,
      null,
      targetFileId,
    );

    expect(fileRepo.create).toHaveBeenCalledTimes(1);
    expect(result.id).not.toBe(targetFileId);
    expect(result.status).toBe('processing');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'file_overwrite_fallback' }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'file_upload' }),
    );
  });

  it('不传 overwriteFileId 时行为与旧逻辑完全一致（新建记录）', async () => {
    const result = await service.createProcessingFile(
      makeMulterFile(),
      '普通上传.png',
      makeUser(ownerId),
      undefined,
      true,
      null,
    );

    expect(fileRepo.findOne).not.toHaveBeenCalled();
    expect(fileRepo.create).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('processing');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'file_upload' }),
    );
    expect(audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'file_overwrite' }));
  });
});

describe('FileService - applyOverwrite', () => {
  let service: FileService;
  let fileRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock; update: jest.Mock; manager: any };
  let audit: { log: jest.Mock; logAwait: jest.Mock };
  let fileCache: { invalidate: jest.Mock; cacheFileFromPath: jest.Mock; isNoCacheMode: jest.Mock };
  let txFileRepo: { findOne: jest.Mock; update: jest.Mock };

  beforeEach(async () => {
    txFileRepo = { findOne: jest.fn(), update: jest.fn().mockResolvedValue(undefined) };
    fileRepo = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      manager: {
        transaction: jest.fn(async (cb: (manager: any) => Promise<void>) => {
          await cb({ getRepository: jest.fn(() => txFileRepo) });
        }),
      },
    };
    audit = { log: jest.fn(), logAwait: jest.fn() };
    fileCache = { invalidate: jest.fn(), cacheFileFromPath: jest.fn().mockResolvedValue(undefined), isNoCacheMode: jest.fn().mockReturnValue(false) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        FileService,
        { provide: getRepositoryToken(File), useValue: fileRepo },
        { provide: getRepositoryToken(Folder), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(FileAccessLog), useValue: {} },
        { provide: getRepositoryToken(BannedIP), useValue: {} },
        { provide: getRepositoryToken(ShareAudit), useValue: {} },
        { provide: TelegramService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
        { provide: JwtService, useValue: {} },
        { provide: ConfigCacheService, useValue: { get: jest.fn(async (_k: string, fb: string) => fb) } },
        { provide: RateLimitService, useValue: {} },
        { provide: UploadJobService, useValue: {} },
        { provide: AuditService, useValue: audit },
        { provide: FileCacheService, useValue: fileCache },
        { provide: getQueueToken(QUEUE_NAMES.FILE_UPLOAD), useValue: { add: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(FileService);
  });

  it('事务内悲观锁复核通过后更新内容引用，保留 id，缓存失效并审计旧 telegramFileId', async () => {
    const target = makeTargetFile();
    txFileRepo.findOne.mockResolvedValue(makeTargetFile());

    const result = await service.applyOverwrite(target, {
      telegramFileId: 'new-tg-file-id',
      telegramFilePath: 'new/path',
      filename: 'new-tg-file-id',
      originalName: '新文件.png',
      size: 5,
      mimeType: 'image/png',
      user: makeUser(ownerId),
    });

    // 悲观行锁复核
    expect(txFileRepo.findOne).toHaveBeenCalledWith({
      where: { id: targetFileId },
      lock: { mode: 'pessimistic_write' },
    });
    // update 替换内容引用且 thumbnailPath 置 null（id 不变，不在 update 字段中）
    expect(txFileRepo.update).toHaveBeenCalledWith(targetFileId, expect.objectContaining({
      telegramFileId: 'new-tg-file-id',
      telegramFilePath: 'new/path',
      originalName: '新文件.png',
      size: 5,
      thumbnailPath: null,
    }));
    expect(result.id).toBe(targetFileId);
    expect(result.telegramFileId).toBe('new-tg-file-id');
    expect(fileCache.invalidate).toHaveBeenCalledWith(targetFileId);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'file_overwrite',
        resourceId: targetFileId,
        metadata: expect.objectContaining({ oldTelegramFileId: 'old-tg-file-id' }),
      }),
    );
  });

  it('事务内复核发现目标已处理中（TOCTOU）抛 BadRequestException，不执行更新', async () => {
    const target = makeTargetFile();
    txFileRepo.findOne.mockResolvedValue(makeTargetFile({ status: 'processing' }));

    await expect(service.applyOverwrite(target, {
      telegramFileId: 'new-tg-file-id',
      telegramFilePath: 'new/path',
      filename: 'new-tg-file-id',
      originalName: '新文件.png',
      size: 5,
      mimeType: 'image/png',
      user: makeUser(ownerId),
    })).rejects.toThrow(BadRequestException);

    expect(txFileRepo.update).not.toHaveBeenCalled();
    expect(fileCache.invalidate).not.toHaveBeenCalled();
  });
});

describe('FileService - access policy branches', () => {
  let service: FileService;
  let fileRepo: any;
  let bannedRepo: any;
  let rateLimit: any;
  let audit: any;
  const qb = (result: any) => {
    const chain: any = {};
    for (const method of ['createQueryBuilder', 'update', 'set', 'where', 'andWhere']) chain[method] = jest.fn(() => chain);
    chain.execute = jest.fn().mockResolvedValue(result);
    chain.getOne = jest.fn().mockResolvedValue(result);
    return chain;
  };

  beforeEach(() => {
    fileRepo = { findOne: jest.fn(), update: jest.fn(), createQueryBuilder: jest.fn(), manager: {} };
    bannedRepo = { createQueryBuilder: jest.fn(), upsert: jest.fn() };
    rateLimit = { incrementCounter: jest.fn(), reset: jest.fn() };
    audit = { log: jest.fn() };
    service = new FileService(
      fileRepo, { findOne: jest.fn() } as any, {} as any, bannedRepo, {} as any,
      {} as any, { get: jest.fn() } as any, {} as any,
      { get: jest.fn(async (_key: string, fallback: string) => fallback) } as any,
      rateLimit, {} as any, audit, {} as any, {} as any,
    );
  });

  it('updates access policy only for existing writable owner files', async () => {
    fileRepo.findOne.mockResolvedValue(null);
    await expect(service.updateAccessType('f', 'public' as any, makeUser(ownerId))).rejects.toThrow(NotFoundException);
    await expect(service.updateAccessCount('f', 1, makeUser(ownerId))).rejects.toThrow(NotFoundException);
    await expect(service.setPassword('f', 'x', makeUser(ownerId))).rejects.toThrow(NotFoundException);
    await expect(service.updateExpires('f', 1, makeUser(ownerId))).rejects.toThrow(NotFoundException);

    fileRepo.findOne.mockResolvedValue(makeTargetFile());
    await service.updateAccessType('f', 'public' as any, makeUser(ownerId));
    await service.updateAccessCount('f', -1, makeUser(ownerId));
    await service.setPassword('f', '', makeUser(ownerId));
    await service.setPassword('f', 'secret', makeUser(ownerId));
    await service.updateExpires('f', null, makeUser(ownerId));
    await service.updateExpires('f', 2, makeUser(ownerId));
    expect(fileRepo.update).toHaveBeenCalledTimes(6);

    (service as any).accessCountMax = 5;
    await expect(service.updateAccessCount('f', 0, makeUser(ownerId))).rejects.toThrow(BadRequestException);
    await expect(service.updateAccessCount('f', 6, makeUser(ownerId))).rejects.toThrow(BadRequestException);
    await service.updateAccessCount('f', 5, makeUser(ownerId));
  });

  it('checks passwords, privacy and access limits across all outcomes', async () => {
    fileRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ password: null });
    await expect(service.verifyPassword('f', 'x')).resolves.toBe(true);
    await expect(service.verifyPassword('f', 'x')).resolves.toBe(true);
    fileRepo.findOne.mockResolvedValueOnce({ password: await require('bcryptjs').hash('ok', 4) });
    await expect(service.verifyPassword('f', 'ok')).resolves.toBe(true);

    fileRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ password: 'x' });
    await expect(service.hasPassword('f')).resolves.toBe(false);
    await expect(service.hasPassword('f')).resolves.toBe(true);
    fileRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ accessType: 'private' }).mockResolvedValueOnce({ accessType: 'public' });
    await expect(service.isPrivateFile('f')).resolves.toBe(false);
    await expect(service.isPrivateFile('f')).resolves.toBe(true);
    await expect(service.isPrivateFile('f')).resolves.toBe(false);

    fileRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.checkAndIncrementAccess('f')).resolves.toEqual({ allowed: false, reason: '文件不存在' });
    fileRepo.findOne.mockResolvedValueOnce({ expiresIn: 1, expiresStartAt: new Date(Date.now() - 7200000), maxAccessCount: -1 });
    await expect(service.checkAndIncrementAccess('f')).resolves.toEqual({ allowed: false, reason: '文件分享已过期' });
    fileRepo.findOne.mockResolvedValueOnce({ expiresIn: null, expiresStartAt: null, maxAccessCount: -1 });
    await expect(service.checkAndIncrementAccess('f')).resolves.toEqual({ allowed: true });
    fileRepo.findOne.mockResolvedValueOnce({ expiresIn: 1, expiresStartAt: new Date(), maxAccessCount: 2 });
    fileRepo.createQueryBuilder.mockReturnValue(qb({ affected: 0 }));
    await expect(service.checkAndIncrementAccess('f')).resolves.toEqual({ allowed: false, reason: '文件访问次数已用尽' });
    fileRepo.findOne.mockResolvedValueOnce({ maxAccessCount: 2 });
    fileRepo.createQueryBuilder.mockReturnValue(qb({ affected: 1 }));
    await expect(service.checkAndIncrementAccess('f')).resolves.toEqual({ allowed: true });
  });

  it('returns permanent, temporary and absent IP ban states', async () => {
    bannedRepo.createQueryBuilder.mockReturnValue(qb(null));
    await expect(service.isIPBanned('ip')).resolves.toEqual({ banned: false });
    bannedRepo.createQueryBuilder.mockReturnValue(qb({ isPermanent: true }));
    await expect(service.isIPBanned('ip')).resolves.toEqual(expect.objectContaining({ banned: true, message: expect.stringContaining('永久') }));
    bannedRepo.createQueryBuilder.mockReturnValue(qb({ isPermanent: false, expiresAt: new Date(Date.now() + 60000) }));
    await expect(service.isIPBanned('ip')).resolves.toEqual(expect.objectContaining({ banned: true, message: expect.stringContaining('分钟') }));
  });

  it('records password attempts below threshold, initial ban and escalated ban', async () => {
    rateLimit.incrementCounter.mockResolvedValueOnce({ count: 1, thresholdReached: false });
    await service.recordFailedPasswordAttempt('ip');
    expect(bannedRepo.upsert).not.toHaveBeenCalled();

    rateLimit.incrementCounter.mockResolvedValueOnce({ count: 5, thresholdReached: true }).mockResolvedValueOnce({ count: 1, thresholdReached: false });
    await service.recordFailedPasswordAttempt('ip');
    expect(bannedRepo.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ reason: expect.stringContaining('第1次') }), ['ip']);

    rateLimit.incrementCounter.mockResolvedValueOnce({ count: 5, thresholdReached: true }).mockResolvedValueOnce({ count: 5, thresholdReached: true });
    await service.recordFailedPasswordAttempt('ip');
    expect(bannedRepo.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ reason: expect.stringContaining('升级为6小时') }), ['ip']);
    expect(rateLimit.reset).toHaveBeenCalledWith('ban:ip');
  });
});

describe('InitChunkUploadDto - overwriteFileId 校验', () => {
  const base = {
    fileName: 'big.zip',
    fileSize: 1024,
    mimeType: 'application/zip',
    totalChunks: 1,
    chunkSize: 1048576,
  };

  it('缺省 overwriteFileId 校验通过（向后兼容）', async () => {
    const dto = plainToInstance(InitChunkUploadDto, base);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('合法 UUID v4 的 overwriteFileId 校验通过', async () => {
    const dto = plainToInstance(InitChunkUploadDto, { ...base, overwriteFileId: targetFileId });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('非法 overwriteFileId（非 UUID）校验失败', async () => {
    const dto = plainToInstance(InitChunkUploadDto, { ...base, overwriteFileId: 'not-a-uuid' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('overwriteFileId');
  });
});

describe('ChunkUploadService - init 覆盖目标预校验', () => {
  let service: ChunkUploadService;
  let fileServiceMock: { getMaxFileSize: jest.Mock; assertOverwriteTarget: jest.Mock };

  beforeEach(async () => {
    fileServiceMock = {
      getMaxFileSize: jest.fn().mockResolvedValue(50 * 1024 * 1024 * 1024),
      assertOverwriteTarget: jest.fn().mockResolvedValue(makeTargetFile()),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ChunkUploadService,
        { provide: FileService, useValue: fileServiceMock },
        { provide: getQueueToken(QUEUE_NAMES.FILE_UPLOAD), useValue: { add: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(ChunkUploadService);
  });

  it('init 时覆盖目标无效直接 400（NotFoundException 亦归一为 BadRequest）', async () => {
    fileServiceMock.assertOverwriteTarget.mockRejectedValue(new NotFoundException('覆盖目标文件不存在或已被删除'));

    await expect(service.init(
      'big.zip', 1024, 'application/zip', 1, 1048576, ownerId, null, targetFileId,
    )).rejects.toThrow(BadRequestException);
    await expect(service.init(
      'big.zip', 1024, 'application/zip', 1, 1048576, ownerId, null, targetFileId,
    )).rejects.toThrow(/覆盖目标无效/);

    expect(fileServiceMock.assertOverwriteTarget).toHaveBeenCalledWith(
      targetFileId,
      { id: ownerId },
      null,
    );
  });

  it('init 时覆盖目标校验通过，会话保存 overwriteFileId', async () => {
    const { uploadId } = await service.init(
      'big.zip', 1024, 'application/zip', 1, 1048576, ownerId, folderId, targetFileId,
    );

    expect(uploadId).toBeDefined();
    expect(fileServiceMock.assertOverwriteTarget).toHaveBeenCalledWith(
      targetFileId,
      { id: ownerId },
      folderId,
    );
    // 会话可正常访问（归属校验通过）
    const status = await service.getStatus(uploadId, ownerId);
    expect(status.mergeStatus).toBe('pending');
    expect((service as any).sessions.get(uploadId).overwriteFileId).toBe(targetFileId);
    expect((service as any).sessions.get(uploadId).folderId).toBe(folderId);
  });

  it('不传 overwriteFileId 时不做预校验（向后兼容）', async () => {
    const { uploadId } = await service.init(
      'big.zip', 1024, 'application/zip', 1, 1048576, ownerId, null,
    );
    expect(uploadId).toBeDefined();
    expect(fileServiceMock.assertOverwriteTarget).not.toHaveBeenCalled();
  });
});

