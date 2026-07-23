import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Readable } from 'stream';

import { FileService } from './file.service';
import { File, FileAccessType } from '../common/entities/file.entity';
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
import { User, UserRole } from '../common/entities/user.entity';
import { QUEUE_NAMES } from '../jobs/bull-queue.module';

// ─── helpers ──────────────────────────────────────────────
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-uuid-1',
    email: 'test@example.com',
    password: 'hashed',
    role: UserRole.USER,
    isBanned: false,
    emailVerified: true,
    ...overrides,
  } as User;
}

function makeFile(overrides: Partial<File> = {}): File {
  return {
    id: 'file-uuid-1',
    filename: 'telegram-file-id',
    originalName: 'test.txt',
    mimeType: 'text/plain',
    size: 1024,
    telegramFileId: 'telegram-file-id',
    telegramFilePath: '',
    thumbnailPath: null,
    folderId: null,
    folder: null,
    accessType: FileAccessType.PUBLIC,
    maxAccessCount: -1,
    expiresIn: null,
    expiresStartAt: null,
    currentAccessCount: 0,
    password: null,
    isDeleted: false,
    deleteRequestedAt: null,
    deleteScheduledAt: null,
    deleteCooldownUntil: null,
    deletedByAdmin: false,
    uploaderId: 'user-uuid-1',
    uploader: null,
    status: 'ready',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as File;
}

function makeMulterFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'test.txt',
    encoding: '7bit',
    mimetype: 'text/plain',
    size: 100,
    buffer: Buffer.from('hello world'),
    destination: '',
    filename: 'test.txt',
    path: '',
    stream: Readable.from('hello world'),
    ...overrides,
  } as Express.Multer.File;
}

// ─── mock factories ───────────────────────────────────────
const mockRepo = () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  save: jest.fn(),
  create: jest.fn((entity: any) => entity),
  remove: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  count: jest.fn(),
  createQueryBuilder: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
    getCount: jest.fn().mockResolvedValue(0),
  })),
});

describe('FileService', () => {
  let service: FileService;
  let fileRepo: ReturnType<typeof mockRepo>;
  let folderRepo: ReturnType<typeof mockRepo>;
  let accessLogRepo: ReturnType<typeof mockRepo>;
  let telegramService: { uploadFile: jest.Mock; getFileStream: jest.Mock; deleteFile: jest.Mock };
  let fileCacheService: { getCachedReadStream: jest.Mock; getCachedPath: jest.Mock; invalidate: jest.Mock };
  let auditService: { log: jest.Mock };
  let configCacheService: { get: jest.Mock; set: jest.Mock };

  beforeEach(async () => {
    fileRepo = mockRepo();
    folderRepo = mockRepo();
    accessLogRepo = mockRepo();

    telegramService = {
      uploadFile: jest.fn(),
      getFileStream: jest.fn(),
      deleteFile: jest.fn(),
    };

    fileCacheService = {
      getCachedReadStream: jest.fn().mockReturnValue(null),
      getCachedPath: jest.fn().mockReturnValue(null),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    auditService = { log: jest.fn() };
    configCacheService = { get: jest.fn(), set: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FileService,
        { provide: getRepositoryToken(File), useValue: fileRepo },
        { provide: getRepositoryToken(Folder), useValue: folderRepo },
        { provide: getRepositoryToken(FileAccessLog), useValue: accessLogRepo },
        { provide: getRepositoryToken(BannedIP), useValue: mockRepo() },
        { provide: getRepositoryToken(ShareAudit), useValue: mockRepo() },
        { provide: TelegramService, useValue: telegramService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'MAX_FILE_SIZE') return '20971520';
              if (key === 'THUMBNAIL_DIR') return '/tmp/thumbnails';
              return null;
            }),
          },
        },
        { provide: JwtService, useValue: { sign: jest.fn(), verify: jest.fn() } },
        { provide: ConfigCacheService, useValue: configCacheService },
        {
          provide: RateLimitService,
          useValue: {
            checkAndIncrement: jest.fn().mockResolvedValue({ allowed: true }),
            reset: jest.fn(),
            getAttemptCount: jest.fn().mockResolvedValue(0),
          },
        },
        { provide: UploadJobService, useValue: { createJob: jest.fn() } },
        { provide: AuditService, useValue: auditService },
        { provide: FileCacheService, useValue: fileCacheService },
        { provide: getQueueToken(QUEUE_NAMES.FILE_UPLOAD), useValue: { add: jest.fn() } },
      ],
    }).compile();

    service = module.get<FileService>(FileService);
  });

  afterEach(() => jest.clearAllMocks());

  // ═══════════════════════════════════════════════════════════
  //  upload()
  // ═══════════════════════════════════════════════════════════
  describe('upload', () => {
    it('应成功上传文件', async () => {
      const user = makeUser();
      const multerFile = makeMulterFile();

      telegramService.uploadFile.mockResolvedValue({
        file_id: 'tg-file-id',
        file_path: 'path/to/file',
      });
      fileRepo.save.mockResolvedValue(makeFile({ id: 'new-file-id' }));

      const result = await service.upload(multerFile, user);

      expect(result).toBeDefined();
      expect(telegramService.uploadFile).toHaveBeenCalled();
      expect(fileRepo.save).toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'file_upload', userId: user.id }),
      );
    });

    it('文件大小超限时应抛出 BadRequestException', async () => {
      const user = makeUser();
      const multerFile = makeMulterFile({ size: 999999999 });

      await expect(service.upload(multerFile, user)).rejects.toThrow(BadRequestException);
      expect(telegramService.uploadFile).not.toHaveBeenCalled();
    });

    it('文件类型不被允许时应抛出 BadRequestException', async () => {
      const user = makeUser();
      // 黑名单 + 非空 filter → .txt 在黑名单中
      (service as any).fileTypeMode = 'blacklist';
      (service as any).fileTypeFilter = ['.txt'];

      const multerFile = makeMulterFile({ originalname: 'test.txt' });

      await expect(service.upload(multerFile, user)).rejects.toThrow(BadRequestException);
      expect(telegramService.uploadFile).not.toHaveBeenCalled();
    });

    it('携带 tagIds 时应关联标签', async () => {
      const user = makeUser();
      const multerFile = makeMulterFile();
      const validTagId = '12345678-1234-1234-1234-123456789012';

      telegramService.uploadFile.mockResolvedValue({
        file_id: 'tg-file-id', file_path: 'path/to/file',
      });
      fileRepo.save.mockResolvedValue(makeFile({ id: 'new-file-id' }));
      // insertFileTags 使用 fileRepository.manager 执行插入
      (fileRepo as any).manager = {
        query: jest.fn().mockResolvedValue([]),
        createQueryBuilder: jest.fn(() => ({
          insert: jest.fn().mockReturnThis(),
          into: jest.fn().mockReturnThis(),
          values: jest.fn().mockReturnThis(),
          orIgnore: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue(undefined),
        })),
      };

      const result = await service.upload(multerFile, user, [validTagId]);
      expect(result).toBeDefined();
      expect(fileRepo.save).toHaveBeenCalled();
    });

    it('图片文件上传后应触发缩略图生成', async () => {
      const user = makeUser();
      const multerFile = makeMulterFile({ mimetype: 'image/png', originalname: 'pic.png' });

      telegramService.uploadFile.mockResolvedValue({
        file_id: 'tg-file-id', file_path: 'path/to/file',
      });
      const savedImg = makeFile({ id: 'img-id', mimeType: 'image/png' });
      fileRepo.save.mockResolvedValue(savedImg);
      // generateAndSaveThumbnail 内部异步执行，spy 避免真实副作用
      const thumbSpy = jest
        .spyOn(service as any, 'generateAndSaveThumbnail')
        .mockResolvedValue(undefined);

      const result = await service.upload(multerFile, user);
      expect(result).toBeDefined();
      expect(thumbSpy).toHaveBeenCalledWith(savedImg);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  findOne()
  // ═══════════════════════════════════════════════════════════
  describe('findOne', () => {
    it('应返回文件（文件所有者）', async () => {
      const user = makeUser();
      const file = makeFile({ uploaderId: user.id });
      fileRepo.findOne.mockResolvedValue(file);

      const result = await service.findOne('file-uuid-1', user);
      expect(result).toEqual(file);
    });

    it('文件不存在时应抛出 NotFoundException', async () => {
      fileRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne('nonexistent', makeUser())).rejects.toThrow(NotFoundException);
    });

    it('非所有者非管理员应抛出 ForbiddenException', async () => {
      const file = makeFile({ uploaderId: 'other-user' });
      fileRepo.findOne.mockResolvedValue(file);
      await expect(service.findOne('file-uuid-1', makeUser({ id: 'current-user' }))).rejects.toThrow(ForbiddenException);
    });

    it('管理员可访问他人文件', async () => {
      const admin = makeUser({ id: 'admin-id', role: UserRole.ADMIN });
      const file = makeFile({ uploaderId: 'other-user' });
      fileRepo.findOne.mockResolvedValue(file);

      const result = await service.findOne('file-uuid-1', admin);
      expect(result).toEqual(file);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  delete()
  // ═══════════════════════════════════════════════════════════
  describe('delete', () => {
    it('应成功标记文件为待删除', async () => {
      const user = makeUser();
      const file = makeFile({ uploaderId: user.id, isDeleted: false });
      fileRepo.findOne.mockResolvedValue(file);
      fileRepo.save.mockResolvedValue(file);

      const result = await service.delete('file-uuid-1', user);

      expect(result.status).toBe('pending');
      expect(result.scheduledAt).toBeDefined();
      expect(file.isDeleted).toBe(true);
      expect(file.deletedByAdmin).toBe(false);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'file_delete_request' }),
      );
    });

    it('文件不存在时应抛出 NotFoundException', async () => {
      fileRepo.findOne.mockResolvedValue(null);
      await expect(service.delete('nonexistent', makeUser())).rejects.toThrow(NotFoundException);
    });

    it('非所有者普通用户应抛出 ForbiddenException', async () => {
      const file = makeFile({ uploaderId: 'other-user' });
      fileRepo.findOne.mockResolvedValue(file);
      await expect(
        service.delete('file-uuid-1', makeUser({ id: 'me', role: UserRole.USER })),
      ).rejects.toThrow(ForbiddenException);
    });

    it('已删除的文件应返回 already_deleted', async () => {
      const user = makeUser();
      const scheduledAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      const file = makeFile({
        uploaderId: user.id,
        isDeleted: true,
        deleteScheduledAt: scheduledAt,
      });
      fileRepo.findOne.mockResolvedValue(file);

      const result = await service.delete('file-uuid-1', user);
      expect(result.status).toBe('already_deleted');
    });

    it('冷却窗口内应抛出 BadRequestException', async () => {
      const user = makeUser();
      const future = new Date(Date.now() + 5 * 60 * 1000);
      const file = makeFile({
        uploaderId: user.id,
        isDeleted: false,
        deleteCooldownUntil: future,
      });
      fileRepo.findOne.mockResolvedValue(file);

      await expect(service.delete('file-uuid-1', user)).rejects.toThrow(BadRequestException);
    });

    it('管理员删除的文件，普通用户不可操作', async () => {
      const file = makeFile({
        uploaderId: 'other-user',
        isDeleted: true,
        deletedByAdmin: true,
      });
      fileRepo.findOne.mockResolvedValue(file);

      await expect(
        service.delete('file-uuid-1', makeUser({ id: 'me', role: UserRole.USER })),
      ).rejects.toThrow(ForbiddenException);
    });

    it('管理员对已标记删除的文件应强制永久删除', async () => {
      const admin = makeUser({ id: 'admin', role: UserRole.ADMIN });
      const file = makeFile({
        uploaderId: 'other-user',
        isDeleted: true,
        deletedByAdmin: true,
      });
      fileRepo.findOne.mockResolvedValue(file);
      fileRepo.count.mockResolvedValue(0);
      telegramService.deleteFile.mockResolvedValue(undefined);
      accessLogRepo.delete.mockResolvedValue(undefined);
      fileRepo.remove.mockResolvedValue(file);

      const result = await service.delete('file-uuid-1', admin);
      expect(result.status).toBe('permanently_deleted');
      expect(fileRepo.remove).toHaveBeenCalledWith(file);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  forceDelete()
  // ═══════════════════════════════════════════════════════════
  describe('forceDelete', () => {
    it('应成功永久删除文件', async () => {
      const user = makeUser();
      const file = makeFile({ uploaderId: user.id });
      fileRepo.findOne.mockResolvedValue(file);
      fileRepo.count.mockResolvedValue(0);
      telegramService.deleteFile.mockResolvedValue(undefined);
      accessLogRepo.delete.mockResolvedValue(undefined);
      fileRepo.remove.mockResolvedValue(file);

      await service.forceDelete('file-uuid-1', user);

      expect(telegramService.deleteFile).toHaveBeenCalledWith('telegram-file-id');
      expect(accessLogRepo.delete).toHaveBeenCalledWith({ fileId: 'file-uuid-1' });
      expect(fileRepo.remove).toHaveBeenCalledWith(file);
      expect(fileCacheService.invalidate).toHaveBeenCalledWith('file-uuid-1');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'file_delete_by_admin', metadata: expect.objectContaining({ forced: true }) }),
      );
    });

    it('文件不存在时应抛出 NotFoundException', async () => {
      fileRepo.findOne.mockResolvedValue(null);
      await expect(service.forceDelete('nonexistent', makeUser())).rejects.toThrow(NotFoundException);
    });

    it('非所有者普通用户应抛出 ForbiddenException', async () => {
      const file = makeFile({ uploaderId: 'other-user' });
      fileRepo.findOne.mockResolvedValue(file);
      await expect(
        service.forceDelete('file-uuid-1', makeUser({ id: 'me', role: UserRole.USER })),
      ).rejects.toThrow(ForbiddenException);
    });

    it('Telegram 删除失败不应阻塞流程', async () => {
      const user = makeUser();
      const file = makeFile({ uploaderId: user.id });
      fileRepo.findOne.mockResolvedValue(file);
      fileRepo.count.mockResolvedValue(0);
      telegramService.deleteFile.mockRejectedValue(new Error('Telegram error'));
      accessLogRepo.delete.mockResolvedValue(undefined);
      fileRepo.remove.mockResolvedValue(file);

      await service.forceDelete('file-uuid-1', user);
      expect(fileRepo.remove).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  checkAndIncrementAccess()
  // ═══════════════════════════════════════════════════════════
  describe('checkAndIncrementAccess', () => {
    it('无限制访问应返回 allowed', async () => {
      fileRepo.findOne.mockResolvedValue(
        makeFile({ maxAccessCount: -1, currentAccessCount: 0, expiresIn: null, expiresStartAt: null }),
      );

      const result = await service.checkAndIncrementAccess('file-uuid-1');
      expect(result.allowed).toBe(true);
    });

    it('文件不存在应返回 not allowed', async () => {
      fileRepo.findOne.mockResolvedValue(null);
      const result = await service.checkAndIncrementAccess('nonexistent');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('文件不存在');
    });

    it('文件已过期应返回 not allowed', async () => {
      const past = new Date(Date.now() - 2 * 3600 * 1000);
      fileRepo.findOne.mockResolvedValue(
        makeFile({ expiresIn: 1, expiresStartAt: past }),
      );
      const result = await service.checkAndIncrementAccess('file-uuid-1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('文件分享已过期');
    });

    it('访问次数耗尽应返回 not allowed', async () => {
      fileRepo.findOne.mockResolvedValue(
        makeFile({ maxAccessCount: 5, currentAccessCount: 5 }),
      );
      // 覆盖 createQueryBuilder 以返回 affected=0（次数耗尽）
      fileRepo.createQueryBuilder.mockReturnValueOnce({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      } as any);

      const result = await service.checkAndIncrementAccess('file-uuid-1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('文件访问次数已用尽');
    });

    it('有限次数且未耗尽应递增并返回 allowed', async () => {
      fileRepo.findOne.mockResolvedValue(
        makeFile({ maxAccessCount: 5, currentAccessCount: 2 }),
      );
      fileRepo.createQueryBuilder.mockReturnValueOnce({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      } as any);

      const result = await service.checkAndIncrementAccess('file-uuid-1');
      expect(result.allowed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  getStreamForShareDownload()
  // ═══════════════════════════════════════════════════════════
  describe('getStreamForShareDownload', () => {
    it('应返回下载流（无缓存时从 Telegram 获取）', async () => {
      const file = makeFile({ mimeType: 'image/png', size: 500 });
      fileRepo.findOne.mockResolvedValue(file);
      fileCacheService.getCachedReadStream.mockReturnValue(null);

      const mockStream = Readable.from('image data');
      telegramService.getFileStream.mockResolvedValue({
        stream: mockStream,
        info: { file_id: 'tg-id', file_path: '', file_size: 500 },
      });
      accessLogRepo.save.mockResolvedValue({ id: 'log-id' });

      const result = await service.getStreamForShareDownload('file-uuid-1', '127.0.0.1');

      expect(result.stream).toBe(mockStream);
      expect(result.contentType).toBe('image/png');
      expect(result.isInline).toBe(true);
      expect(result.size).toBe(500);
      expect(result.accessLogId).toBe('log-id');
      expect(accessLogRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 'file-uuid-1', action: 'share_download' }),
      );
    });

    it('文件不存在时应抛出 NotFoundException', async () => {
      fileRepo.findOne.mockResolvedValue(null);
      await expect(service.getStreamForShareDownload('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  restoreDelete()
  // ═══════════════════════════════════════════════════════════
  describe('restoreDelete', () => {
    it('应成功恢复已删除的文件', async () => {
      const user = makeUser();
      const future = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      const file = makeFile({
        uploaderId: user.id,
        isDeleted: true,
        deleteRequestedAt: new Date(),
        deleteScheduledAt: future,
      });
      fileRepo.findOne.mockResolvedValue(file);
      fileRepo.save.mockResolvedValue(file);

      await service.restoreDelete('file-uuid-1', user);

      expect(file.isDeleted).toBe(false);
      expect(file.deletedByAdmin).toBe(false);
      expect(file.deleteRequestedAt).toBeNull();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'file_restore' }),
      );
    });

    it('文件不存在或未标记删除应抛出 NotFoundException', async () => {
      fileRepo.findOne.mockResolvedValue(null);
      await expect(service.restoreDelete('nonexistent', makeUser())).rejects.toThrow(NotFoundException);
    });

    it('删除等待期已过应抛出 BadRequestException', async () => {
      const user = makeUser();
      const past = new Date(Date.now() - 1000);
      const file = makeFile({
        uploaderId: user.id,
        isDeleted: true,
        deleteRequestedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000),
        deleteScheduledAt: past,
      });
      fileRepo.findOne.mockResolvedValue(file);

      await expect(service.restoreDelete('file-uuid-1', user)).rejects.toThrow(BadRequestException);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  updateAccessType()
  // ═══════════════════════════════════════════════════════════
  describe('updateAccessType', () => {
    it('应成功更新文件访问类型', async () => {
      const user = makeUser();
      const file = makeFile({ uploaderId: user.id });
      fileRepo.findOne.mockResolvedValue(file);

      await service.updateAccessType('file-uuid-1', FileAccessType.PRIVATE, user);

      expect(fileRepo.update).toHaveBeenCalledWith('file-uuid-1', { accessType: FileAccessType.PRIVATE });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'file_access_change', metadata: { accessType: FileAccessType.PRIVATE } }),
      );
    });

    it('文件不存在应抛出 NotFoundException', async () => {
      fileRepo.findOne.mockResolvedValue(null);
      await expect(
        service.updateAccessType('nonexistent', FileAccessType.PUBLIC, makeUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  updateAccessCount()
  // ═══════════════════════════════════════════════════════════
  describe('updateAccessCount', () => {
    it('应成功更新访问次数限制', async () => {
      const user = makeUser();
      const file = makeFile({ uploaderId: user.id });
      fileRepo.findOne.mockResolvedValue(file);

      await service.updateAccessCount('file-uuid-1', 100, user);

      expect(fileRepo.update).toHaveBeenCalledWith('file-uuid-1', { maxAccessCount: 100 });
    });

    it('文件不存在应抛出 NotFoundException', async () => {
      fileRepo.findOne.mockResolvedValue(null);
      await expect(
        service.updateAccessCount('nonexistent', 10, makeUser()),
      ).rejects.toThrow(NotFoundException);
    });

    it('accessCountMax 限制下超出范围应抛出 BadRequestException', async () => {
      const user = makeUser();
      const file = makeFile({ uploaderId: user.id });
      fileRepo.findOne.mockResolvedValue(file);
      (service as any).accessCountMax = 100;

      await expect(
        service.updateAccessCount('file-uuid-1', 200, user),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.updateAccessCount('file-uuid-1', -1, user),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  setPassword()
  // ═══════════════════════════════════════════════════════════
  describe('setPassword', () => {
    it('应成功设置文件密码', async () => {
      const user = makeUser();
      const file = makeFile({ uploaderId: user.id });
      fileRepo.findOne.mockResolvedValue(file);

      await service.setPassword('file-uuid-1', 'mypassword', user);

      expect(fileRepo.update).toHaveBeenCalledWith(
        'file-uuid-1',
        { password: expect.stringMatching(/^\$2/) },
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'file_password_set' }),
      );
    });

    it('传空字符串应清除密码', async () => {
      const user = makeUser();
      const file = makeFile({ uploaderId: user.id });
      fileRepo.findOne.mockResolvedValue(file);

      await service.setPassword('file-uuid-1', '', user);

      expect(fileRepo.update).toHaveBeenCalledWith('file-uuid-1', { password: null });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'file_password_remove' }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  hasPassword() / isPrivateFile()
  // ═══════════════════════════════════════════════════════════
  describe('hasPassword', () => {
    it('文件有密码应返回 true', async () => {
      fileRepo.findOne.mockResolvedValue(makeFile({ password: 'hashed-pwd' }));
      const result = await service.hasPassword('file-uuid-1');
      expect(result).toBe(true);
    });

    it('文件无密码应返回 false', async () => {
      fileRepo.findOne.mockResolvedValue(makeFile({ password: null }));
      const result = await service.hasPassword('file-uuid-1');
      expect(result).toBe(false);
    });

    it('文件不存在应返回 false', async () => {
      fileRepo.findOne.mockResolvedValue(null);
      const result = await service.hasPassword('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('isPrivateFile', () => {
    it('私有文件应返回 true', async () => {
      fileRepo.findOne.mockResolvedValue(makeFile({ accessType: FileAccessType.PRIVATE }));
      const result = await service.isPrivateFile('file-uuid-1');
      expect(result).toBe(true);
    });

    it('公开文件应返回 false', async () => {
      fileRepo.findOne.mockResolvedValue(makeFile({ accessType: FileAccessType.PUBLIC }));
      const result = await service.isPrivateFile('file-uuid-1');
      expect(result).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  getMaxFileSize() / getFileTypeConfig()
  // ═══════════════════════════════════════════════════════════
  describe('getMaxFileSize', () => {
    it('应返回最大文件大小', async () => {
      const result = await service.getMaxFileSize();
      expect(result).toBe(20971520);
    });
  });

  describe('getFileTypeConfig', () => {
    it('应返回文件类型配置', async () => {
      const result = await service.getFileTypeConfig();
      expect(result.fileTypeMode).toBe('blacklist');
      expect(result.fileTypeFilter).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  isFileTypeAllowed()
  // ═══════════════════════════════════════════════════════════
  describe('isFileTypeAllowed', () => {
    it('黑名单空列表应允许所有文件', async () => {
      const result = await service.isFileTypeAllowed('test.txt', Buffer.from('hello'));
      expect(result.allowed).toBe(true);
    });

    it('黑名单中包含该类型应拒绝', async () => {
      (service as any).fileTypeFilter = ['.txt'];
      const result = await service.isFileTypeAllowed('test.txt', Buffer.from('hello'));
      expect(result.allowed).toBe(false);
    });

    it('白名单模式下未配置允许类型应拒绝', async () => {
      (service as any).fileTypeMode = 'whitelist';
      (service as any).fileTypeFilter = [];
      const result = await service.isFileTypeAllowed('test.txt', Buffer.from('hello'));
      expect(result.allowed).toBe(false);
    });

    it('白名单模式下包含该类型应允许', async () => {
      (service as any).fileTypeMode = 'whitelist';
      (service as any).fileTypeFilter = ['.png'];
      // PNG magic bytes: 0x89 0x50 0x4e 0x47
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      const result = await service.isFileTypeAllowed('test.png', pngBuffer);
      expect(result.allowed).toBe(true);
    });

    it('白名单模式下不包含该类型应拒绝', async () => {
      (service as any).fileTypeMode = 'whitelist';
      (service as any).fileTypeFilter = ['.txt'];
      const result = await service.isFileTypeAllowed('test.txt', Buffer.from('hello'));
      expect(result.allowed).toBe(false);
    });

    it('黑名单模式下不包含该类型应允许', async () => {
      (service as any).fileTypeMode = 'blacklist';
      (service as any).fileTypeFilter = ['.exe'];
      const result = await service.isFileTypeAllowed('test.txt', Buffer.from('hello'));
      expect(result.allowed).toBe(true);
    });

    it('黑名单模式下复合扩展名 .tar.gz 应正确匹配', async () => {
      (service as any).fileTypeMode = 'blacklist';
      (service as any).fileTypeFilter = ['.tar.gz'];
      // 无 magic bytes 检测结果 → 回退到文件名后缀匹配
      const result = await service.isFileTypeAllowed('archive.tar.gz', Buffer.from('hello'));
      expect(result.allowed).toBe(false);
    });

    it('黑名单模式下复合扩展名不在黑名单中应允许', async () => {
      (service as any).fileTypeMode = 'blacklist';
      (service as any).fileTypeFilter = ['.exe'];
      const result = await service.isFileTypeAllowed('archive.tar.gz', Buffer.from('hello'));
      expect(result.allowed).toBe(true);
    });

    it('无 buffer 时黑名单应回退到文件名后缀', async () => {
      (service as any).fileTypeMode = 'blacklist';
      (service as any).fileTypeFilter = ['.txt'];
      const result = await service.isFileTypeAllowed('test.txt');
      expect(result.allowed).toBe(false);
    });

    it('无扩展名文件名应返回 (无扩展名)', async () => {
      (service as any).fileTypeMode = 'blacklist';
      (service as any).fileTypeFilter = ['.txt'];
      const result = await service.isFileTypeAllowed('README', Buffer.from('hello'));
      expect(result.allowed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  updateExpires()
  // ═══════════════════════════════════════════════════════════
  describe('updateExpires', () => {
    it('文件不存在时应抛出 NotFoundException', async () => {
      fileRepo.findOne.mockResolvedValue(null);
      await expect(service.updateExpires('no-file', 24, makeUser()))
        .rejects.toThrow(NotFoundException);
    });

    it('应成功设置有效期', async () => {
      const file = makeFile();
      fileRepo.findOne.mockResolvedValue(file);
      fileRepo.update.mockResolvedValue(undefined);

      await service.updateExpires('file-uuid-1', 24, makeUser());

      expect(fileRepo.update).toHaveBeenCalledWith(
        'file-uuid-1',
        expect.objectContaining({ expiresIn: 24 }),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'file_expiry_set' }),
      );
    });

    it('传入 null 应清除有效期', async () => {
      const file = makeFile();
      fileRepo.findOne.mockResolvedValue(file);
      fileRepo.update.mockResolvedValue(undefined);

      await service.updateExpires('file-uuid-1', null, makeUser());

      expect(fileRepo.update).toHaveBeenCalledWith(
        'file-uuid-1',
        expect.objectContaining({ expiresIn: null, expiresStartAt: null }),
      );
    });

    it('非所有者普通用户应抛出 ForbiddenException', async () => {
      const file = makeFile({ uploaderId: 'other-user' });
      fileRepo.findOne.mockResolvedValue(file);

      await expect(service.updateExpires('file-uuid-1', 24, makeUser()))
        .rejects.toThrow(ForbiddenException);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  renameFile()
  // ═══════════════════════════════════════════════════════════
  describe('renameFile', () => {
    it('文件不存在时应抛出 NotFoundException', async () => {
      fileRepo.findOne.mockResolvedValue(null);
      await expect(service.renameFile('no-file', 'new-name.txt', makeUser()))
        .rejects.toThrow(NotFoundException);
    });

    it('应成功重命名文件', async () => {
      const file = makeFile({ originalName: 'old-name.txt' });
      fileRepo.findOne.mockResolvedValue(file);
      fileRepo.save.mockResolvedValue({ ...file, originalName: 'new-name.txt' });

      const result = await service.renameFile('file-uuid-1', 'new-name.txt', makeUser());

      expect(result.originalName).toBe('new-name.txt');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'file_rename',
          metadata: { from: 'old-name.txt', to: 'new-name.txt' },
        }),
      );
    });

    it('非所有者普通用户应抛出 ForbiddenException', async () => {
      const file = makeFile({ uploaderId: 'other-user' });
      fileRepo.findOne.mockResolvedValue(file);

      await expect(service.renameFile('file-uuid-1', 'new-name.txt', makeUser()))
        .rejects.toThrow(ForbiddenException);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  verifyPassword()
  // ═══════════════════════════════════════════════════════════
  describe('verifyPassword', () => {
    it('文件不存在时应返回 true', async () => {
      fileRepo.findOne.mockResolvedValue(null);
      const result = await service.verifyPassword('no-file', 'password');
      expect(result).toBe(true);
    });

    it('文件无密码时应返回 true', async () => {
      fileRepo.findOne.mockResolvedValue(makeFile({ password: null }));
      const result = await service.verifyPassword('file-uuid-1', 'password');
      expect(result).toBe(true);
    });

    it('密码正确时应返回 true', async () => {
      const bcrypt = require('bcryptjs');
      const hashed = bcrypt.hashSync('correct-pass', 10);
      fileRepo.findOne.mockResolvedValue(makeFile({ password: hashed }));
      const result = await service.verifyPassword('file-uuid-1', 'correct-pass');
      expect(result).toBe(true);
    });

    it('密码错误时应返回 false', async () => {
      const bcrypt = require('bcryptjs');
      const hashed = bcrypt.hashSync('correct-pass', 10);
      fileRepo.findOne.mockResolvedValue(makeFile({ password: hashed }));
      const result = await service.verifyPassword('file-uuid-1', 'wrong-pass');
      expect(result).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  copyFile()
  // ═══════════════════════════════════════════════════════════
  describe('copyFile', () => {
    it('源文件不存在时应抛出 NotFoundException', async () => {
      fileRepo.findOne.mockResolvedValue(null);
      await expect(service.copyFile('no-file', null, makeUser()))
        .rejects.toThrow(NotFoundException);
    });

    it('目标文件夹不存在时应抛出 NotFoundException', async () => {
      fileRepo.findOne.mockResolvedValue(makeFile());
      folderRepo.findOne.mockResolvedValue(null);

      await expect(service.copyFile('file-uuid-1', 'folder-1', makeUser()))
        .rejects.toThrow(NotFoundException);
    });

    it('应成功复制文件到根目录（有扩展名）', async () => {
      const source = makeFile({ originalName: 'doc.pdf' });
      fileRepo.findOne.mockResolvedValue(source);
      const savedCopy = { ...source, id: 'copy-id', originalName: 'doc 副本.pdf' };
      fileRepo.create.mockReturnValue(savedCopy);
      fileRepo.save.mockResolvedValue(savedCopy);

      const result = await service.copyFile('file-uuid-1', null, makeUser());

      expect(result.originalName).toBe('doc 副本.pdf');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'file_copy' }),
      );
    });

    it('应成功复制文件到根目录（无扩展名）', async () => {
      const source = makeFile({ originalName: 'README' });
      fileRepo.findOne.mockResolvedValue(source);
      const savedCopy = { ...source, id: 'copy-id', originalName: 'README 副本' };
      fileRepo.create.mockReturnValue(savedCopy);
      fileRepo.save.mockResolvedValue(savedCopy);

      const result = await service.copyFile('file-uuid-1', null, makeUser());

      expect(result.originalName).toBe('README 副本');
    });

    it('应成功复制文件到指定文件夹', async () => {
      const source = makeFile({ originalName: 'doc.pdf' });
      fileRepo.findOne.mockResolvedValue(source);
      folderRepo.findOne.mockResolvedValue({ id: 'folder-1', ownerId: 'user-uuid-1' });
      const savedCopy = { ...source, id: 'copy-id', originalName: 'doc 副本.pdf', folderId: 'folder-1' };
      fileRepo.create.mockReturnValue(savedCopy);
      fileRepo.save.mockResolvedValue(savedCopy);

      const result = await service.copyFile('file-uuid-1', 'folder-1', makeUser());

      expect(result.folderId).toBe('folder-1');
    });
  });
});

