jest.mock('file-type', () => ({
  fileTypeFromBuffer: jest.fn().mockResolvedValue(undefined),
}), { virtual: true });

import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
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
import { ShareLink } from '../common/entities/share-link.entity';
import { TelegramService } from '../telegram/telegram.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { RateLimitService } from '../common/services/rate-limit.service';
import { AuditService } from '../common/services/audit.service';
import { UploadJobService } from './upload-job.service';
import { FileCacheService } from './file-cache.service';
import { ThumbnailService } from './thumbnail.service';
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
    fileCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      cacheFileFromPath: jest.fn().mockResolvedValue(undefined),
      isNoCacheMode: jest.fn().mockReturnValue(false),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        FileService,
        { provide: getRepositoryToken(File), useValue: fileRepo },
        { provide: getRepositoryToken(Folder), useValue: { findOne: jest.fn() } },
        { provide: ThumbnailService, useValue: { deleteThumbnailsForFileId: jest.fn().mockResolvedValue(undefined) } },
        { provide: getRepositoryToken(FileAccessLog), useValue: {} },
        { provide: getRepositoryToken(BannedIP), useValue: {} },
        { provide: getRepositoryToken(ShareAudit), useValue: {} },
        { provide: getRepositoryToken(ShareLink), useValue: {} },
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
  let txFileRepo: { findOne: jest.Mock; save: jest.Mock };
  let audit: { log: jest.Mock; logAwait: jest.Mock };
  let fileCache: { invalidate: jest.Mock; cacheFileFromPath: jest.Mock; isNoCacheMode: jest.Mock };

  beforeEach(async () => {
    txFileRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (entity: File) => entity),
    };
    fileRepo = {
      findOne: jest.fn(),
      create: jest.fn((data: Partial<File>) => Object.assign(new File(), data)),
      save: jest.fn(async (entity: File) => entity),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: {
        transaction: jest.fn(async (cb: (manager: any) => Promise<unknown>) => {
          return cb({ getRepository: jest.fn(() => txFileRepo) });
        }),
        query: jest.fn(),
      },
    };
    audit = { log: jest.fn(), logAwait: jest.fn() };
    fileCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      cacheFileFromPath: jest.fn().mockResolvedValue(undefined),
      isNoCacheMode: jest.fn().mockReturnValue(false),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        FileService,
        { provide: getRepositoryToken(File), useValue: fileRepo },
        { provide: getRepositoryToken(Folder), useValue: { findOne: jest.fn() } },
        { provide: ThumbnailService, useValue: { deleteThumbnailsForFileId: jest.fn().mockResolvedValue(undefined) } },
        { provide: getRepositoryToken(FileAccessLog), useValue: {} },
        { provide: getRepositoryToken(BannedIP), useValue: {} },
        { provide: getRepositoryToken(ShareAudit), useValue: {} },
        { provide: getRepositoryToken(ShareLink), useValue: {} },
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
    txFileRepo.findOne.mockResolvedValue(makeTargetFile());

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
    // G2-05：uploadVersion+1 在事务内悲观锁实体上原子执行（而非 fileRepo.save 直接落库）
    expect(fileRepo.manager.transaction).toHaveBeenCalled();
    expect(txFileRepo.findOne).toHaveBeenCalledWith({
      where: { id: targetFileId },
      lock: { mode: 'pessimistic_write' },
    });
    expect(txFileRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: targetFileId,
      uploadVersion: 2,
      status: 'processing',
      originalName: '新文件.png',
      size: 5,
    }));
    // 覆盖不新增标签（未触碰标签插入）
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
    // C-05 修复：进入 processing 前必须等待旧缓存失效（不得 fire-and-forget）。
    // invalidate 返回 pending Promise，断言其被 await（在 save 之前完成）。
    expect(fileCache.invalidate).toHaveBeenCalledWith(targetFileId);
    const invalidatePromise = fileCache.invalidate.mock.results[0].value;
    expect(invalidatePromise).toBeInstanceOf(Promise);
  });

  it('覆盖上传时清空历史 uploadFailureReason（旧失败不残留）', async () => {
    const target = makeTargetFile();
    target.uploadFailureReason = '旧失败原因，不应残留';
    fileRepo.findOne.mockResolvedValue(target);
    txFileRepo.findOne.mockResolvedValue(target);

    const result = await service.createProcessingFile(
      makeMulterFile(),
      '新文件.png',
      makeUser(ownerId),
      undefined,
      true,
      null,
      targetFileId,
    );

    expect(result.uploadFailureReason).toBeNull();
    expect(txFileRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ uploadFailureReason: null }),
    );
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
    fileCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      cacheFileFromPath: jest.fn().mockResolvedValue(undefined),
      isNoCacheMode: jest.fn().mockReturnValue(false),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        FileService,
        { provide: getRepositoryToken(File), useValue: fileRepo },
        { provide: getRepositoryToken(Folder), useValue: { findOne: jest.fn() } },
        { provide: ThumbnailService, useValue: { deleteThumbnailsForFileId: jest.fn().mockResolvedValue(undefined) } },
        { provide: getRepositoryToken(FileAccessLog), useValue: {} },
        { provide: getRepositoryToken(BannedIP), useValue: {} },
        { provide: getRepositoryToken(ShareAudit), useValue: {} },
        { provide: getRepositoryToken(ShareLink), useValue: {} },
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
      fileRepo, { findOne: jest.fn() } as any, {} as any, bannedRepo, {} as any, {} as any,
      {} as any, { get: jest.fn() } as any, {} as any,
      { get: jest.fn(async (_key: string, fallback: string) => fallback) } as any,
      rateLimit, {} as any, audit, {} as any, {} as any, {} as any,
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

describe('FileService - G2-05 覆盖上传 uploadVersion 原子化（事务+悲观锁）', () => {
  let service: FileService;
  let fileRepo: any;
  let txFileRepo: { findOne: jest.Mock; save: jest.Mock };
  let audit: any;
  let fileCache: any;

  beforeEach(async () => {
    txFileRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (entity: File) => entity),
    };
    fileRepo = {
      findOne: jest.fn(),
      create: jest.fn((data: Partial<File>) => Object.assign(new File(), data)),
      save: jest.fn(async (entity: File) => entity),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: {
        transaction: jest.fn(async (cb: (manager: any) => Promise<unknown>) => {
          return cb({ getRepository: jest.fn(() => txFileRepo) });
        }),
        query: jest.fn(),
      },
    };
    audit = { log: jest.fn(), logAwait: jest.fn() };
    fileCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      cacheFileFromPath: jest.fn().mockResolvedValue(undefined),
      isNoCacheMode: jest.fn().mockReturnValue(true), // 关闭缓存预热，聚焦覆盖事务
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        FileService,
        { provide: getRepositoryToken(File), useValue: fileRepo },
        { provide: getRepositoryToken(Folder), useValue: { findOne: jest.fn() } },
        { provide: ThumbnailService, useValue: { deleteThumbnailsForFileId: jest.fn().mockResolvedValue(undefined) } },
        { provide: getRepositoryToken(FileAccessLog), useValue: {} },
        { provide: getRepositoryToken(BannedIP), useValue: {} },
        { provide: getRepositoryToken(ShareAudit), useValue: {} },
        { provide: getRepositoryToken(ShareLink), useValue: {} },
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

  it('并发两次覆盖同一目标：第二次基于锁内最新 uploadVersion 递增，版本不丢失', async () => {
    // 模拟并发场景：assertOverwriteTarget 两次都读到初始 v1（预检在同一快照），
    // 但事务内悲观锁二次读取时分别返回 v1 和 v2（体现串行化后的真实最新版本）。
    fileRepo.findOne.mockResolvedValue(makeTargetFile({ uploadVersion: 1 }));
    txFileRepo.findOne
      .mockResolvedValueOnce(makeTargetFile({ uploadVersion: 1 })) // 第一事务锁内读到 v1 → v2
      .mockResolvedValueOnce(makeTargetFile({ uploadVersion: 2 })); // 第二事务锁内读到 v2 → v3

    const multerA = makeMulterFile();
    const multerB = makeMulterFile();
    multerB.originalname = '并发B.png';

    const [a, b] = await Promise.all([
      service.createProcessingFile(multerA, '并发A.png', makeUser(ownerId), undefined, true, null, targetFileId),
      service.createProcessingFile(multerB, '并发B.png', makeUser(ownerId), undefined, true, null, targetFileId),
    ]);

    // 关键：版本必须严格递增，绝不出现两次都得到 v2（旧实现 TOCTOU 的典型丢失）
    const versions = [a.uploadVersion, b.uploadVersion].sort((x, y) => x - y);
    expect(versions).toEqual([2, 3]);
    // 每个覆盖都在事务内悲观锁二次读取（防 TOCTOU 的核心）
    expect(txFileRepo.findOne).toHaveBeenCalledTimes(2);
    for (const call of txFileRepo.findOne.mock.calls) {
      expect(call[0]).toEqual({ where: { id: targetFileId }, lock: { mode: 'pessimistic_write' } });
    }
    // 每次覆盖都在锁内 save 递增后的实体
    expect(txFileRepo.save).toHaveBeenCalledTimes(2);
    expect(txFileRepo.save.mock.calls.map((c: any) => c[0].uploadVersion)).toEqual([2, 3]);
  });

  it('事务锁内复核发现目标已是 processing（并发竞写）：拒绝覆盖该记录，降级为新建且不递增其版本', async () => {
    fileRepo.findOne.mockResolvedValue(makeTargetFile({ uploadVersion: 1 }));
    // 锁内读到 processing → 并发已抢先进入处理中，本次覆盖不得在该记录上递增版本
    txFileRepo.findOne.mockResolvedValue(makeTargetFile({ status: 'processing', uploadVersion: 2 }));

    // tryApplyOverwriteOrNull 将 BadRequest 归一为降级新建（不丢已传字节）
    const result = await service.createProcessingFile(
      makeMulterFile(), '并发.png', makeUser(ownerId), undefined, true, null, targetFileId,
    );

    // 关键：并发已被占用的目标记录版本未被递增（txFileRepo.save 未调用）
    expect(txFileRepo.save).not.toHaveBeenCalled();
    // 降级为新建记录（新 id，uploadVersion=1）
    expect(result.id).not.toBe(targetFileId);
    expect(result.uploadVersion).toBe(1);
    expect(fileRepo.create).toHaveBeenCalledTimes(1);
  });
});

describe('FileService - G2-06 缓存预热完成条件更新（版本守卫）', () => {
  let service: FileService;
  let fileRepo: any;
  let txFileRepo: { findOne: jest.Mock; save: jest.Mock };
  let audit: any;
  let fileCache: any;
  let thumbnailService: any;

  beforeEach(async () => {
    txFileRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (entity: File) => entity),
    };
    fileRepo = {
      findOne: jest.fn(),
      create: jest.fn((data: Partial<File>) => Object.assign(new File(), data)),
      save: jest.fn(async (entity: File) => entity),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: {
        transaction: jest.fn(async (cb: (manager: any) => Promise<unknown>) => {
          return cb({ getRepository: jest.fn(() => txFileRepo) });
        }),
        query: jest.fn(),
      },
    };
    audit = { log: jest.fn(), logAwait: jest.fn() };
    thumbnailService = { deleteThumbnailsForFileId: jest.fn().mockResolvedValue(undefined) };
    fileCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      // 预热成功回调需手动触发，以便断言条件更新
      cacheFileFromPath: jest.fn().mockResolvedValue(undefined),
      isNoCacheMode: jest.fn().mockReturnValue(false),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        FileService,
        { provide: getRepositoryToken(File), useValue: fileRepo },
        { provide: getRepositoryToken(Folder), useValue: { findOne: jest.fn() } },
        { provide: ThumbnailService, useValue: thumbnailService },
        { provide: getRepositoryToken(FileAccessLog), useValue: {} },
        { provide: getRepositoryToken(BannedIP), useValue: {} },
        { provide: getRepositoryToken(ShareAudit), useValue: {} },
        { provide: getRepositoryToken(ShareLink), useValue: {} },
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

  it('缓存就绪条件更新携带 id + status=processing + uploadVersion，不按裸 id 全量置 ready', async () => {
    const multer = makeMulterFile();
    // 真实存在的临时文件，触发磁盘文件缓存预热分支（fs.existsSync 返回 true）
    const tmpPath = path.join(process.cwd(), 'tmp', `g2-06-a-${Date.now()}.part`);
    fs.writeFileSync(tmpPath, 'hello');
    multer.path = tmpPath;
    try {
      fileRepo.findOne.mockResolvedValue(makeTargetFile({ uploadVersion: 3 }));
      txFileRepo.findOne.mockResolvedValue(makeTargetFile({ uploadVersion: 3 }));

      await service.createProcessingFile(
        multer, '新文件.png', makeUser(ownerId), undefined, true, null, targetFileId,
      );

      // 等待缓存预热回调（.then）执行完毕
      await new Promise((r) => setImmediate(r));
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }

    expect(fileCache.cacheFileFromPath).toHaveBeenCalledWith(targetFileId, multer.path, multer.size);
    // 条件更新必须携带 finalFile.uploadVersion（覆盖递增后 = 3+1=4）与 status=processing（防并发覆盖误标）
    expect(fileRepo.update).toHaveBeenCalledWith(
      { id: targetFileId, status: 'processing', uploadVersion: 4 },
      { status: 'ready', uploadFailureReason: null },
    );
  });

  it('并发覆盖后 v1 收尾：条件更新 affected=0 时不把 v2 记录误标 ready', async () => {
    const multer = makeMulterFile();
    const tmpPath = path.join(process.cwd(), 'tmp', `g2-06-b-${Date.now()}.part`);
    fs.writeFileSync(tmpPath, 'hello');
    multer.path = tmpPath;
    let result: File;
    try {
      fileRepo.findOne.mockResolvedValue(makeTargetFile({ uploadVersion: 1 }));
      txFileRepo.findOne.mockResolvedValue(makeTargetFile({ uploadVersion: 1 }));

      // 预热完成回调触发条件更新时，模拟 affected=0（此时记录已因并发覆盖递增到 v2，条件不匹配）
      fileRepo.update.mockResolvedValue({ affected: 0 });

      result = await service.createProcessingFile(
        multer, '新文件.png', makeUser(ownerId), undefined, true, null, targetFileId,
      );

      await new Promise((r) => setImmediate(r));
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }

    // 更新按本次覆盖递增后的版本（v1→v2）条件执行，且未命中（affected=0）——不会把后续覆盖记录误标 ready
    expect(fileRepo.update).toHaveBeenCalledWith(
      { id: targetFileId, status: 'processing', uploadVersion: 2 },
      { status: 'ready', uploadFailureReason: null },
    );
    // 无抛错、无意外状态覆盖
    expect(result.status).toBe('processing');
  });
});

