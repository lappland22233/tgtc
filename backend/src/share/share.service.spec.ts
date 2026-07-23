import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { Readable } from 'stream';

import { ShareService } from './share.service';
import { ShareLink, ShareTargetType, ShareLinkStatus } from '../common/entities/share-link.entity';
import { File } from '../common/entities/file.entity';
import { Folder } from '../common/entities/folder.entity';
import { AuditService } from '../common/services/audit.service';
import { SharePasswordService } from './share-password.service';
import { FileService } from '../file/file.service';
import { BCRYPT_ROUNDS } from '../common/constants/bcrypt';

// ─── helpers ──────────────────────────────────────────────
function makeShareLink(overrides: Partial<ShareLink> = {}): ShareLink {
  return {
    id: 'share-uuid-1',
    token: 'testtoken123',
    targetType: ShareTargetType.FILE,
    targetId: 'file-uuid-1',
    creatorId: 'user-uuid-1',
    password: null,
    maxAccessCount: -1,
    currentAccessCount: 0,
    expiresIn: null,
    expiresStartAt: null,
    status: ShareLinkStatus.ACTIVE,
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ShareLink;
}

function makeFile(overrides: Partial<File> = {}): File {
  return {
    id: 'file-uuid-1',
    filename: 'tg-file-id',
    originalName: 'document.pdf',
    mimeType: 'application/pdf',
    size: 2048,
    telegramFileId: 'tg-file-id',
    telegramFilePath: '',
    thumbnailPath: null,
    folderId: null,
    folder: null,
    accessType: 'public' as any,
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

// ─── mock factory ─────────────────────────────────────────
const mockRepo = () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  findAndCount: jest.fn(),
  save: jest.fn().mockResolvedValue(undefined),
  create: jest.fn((entity: any) => entity),
  createQueryBuilder: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
    getCount: jest.fn().mockResolvedValue(0),
  })),
});

describe('ShareService', () => {
  let service: ShareService;
  let shareLinkRepo: ReturnType<typeof mockRepo>;
  let fileRepo: ReturnType<typeof mockRepo>;
  let folderRepo: any;
  let passwordService: {
    isIPBanned: jest.Mock;
    recordFailedAttempt: jest.Mock;
    issueAccessJwt: jest.Mock;
    verifyAccessJwt: jest.Mock;
  };
  let fileService: { getStreamForShareDownload: jest.Mock };
  let auditService: { log: jest.Mock };

  beforeEach(async () => {
    shareLinkRepo = mockRepo();
    fileRepo = mockRepo();
    folderRepo = {
      ...mockRepo(),
      manager: { query: jest.fn().mockResolvedValue([]) },
      findAncestors: jest.fn().mockResolvedValue([]),
    };

    passwordService = {
      isIPBanned: jest.fn().mockResolvedValue({ banned: false }),
      recordFailedAttempt: jest.fn().mockResolvedValue(undefined),
      issueAccessJwt: jest.fn().mockResolvedValue('mock-access-jwt'),
      verifyAccessJwt: jest.fn().mockResolvedValue(true),
    };

    fileService = {
      getStreamForShareDownload: jest.fn().mockResolvedValue({
        stream: Readable.from('file data'),
        contentType: 'application/pdf',
        filename: 'document.pdf',
        size: 2048,
        isInline: false,
        accessLogId: 'log-id',
      }),
    };

    auditService = { log: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShareService,
        { provide: getRepositoryToken(ShareLink), useValue: shareLinkRepo },
        { provide: getRepositoryToken(File), useValue: fileRepo },
        { provide: getRepositoryToken(Folder), useValue: folderRepo },
        { provide: AuditService, useValue: auditService },
        { provide: SharePasswordService, useValue: passwordService },
        { provide: FileService, useValue: fileService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('http://localhost:3000') },
        },
      ],
    }).compile();

    service = module.get<ShareService>(ShareService);
  });

  afterEach(() => jest.clearAllMocks());

  // ═══════════════════════════════════════════════════════════
  //  createShare()
  // ═══════════════════════════════════════════════════════════
  describe('createShare', () => {
    it('应成功创建文件分享', async () => {
      fileRepo.findOne.mockResolvedValue(makeFile());
      shareLinkRepo.findOne.mockResolvedValue(null); // token 不存在
      shareLinkRepo.save.mockResolvedValue(makeShareLink({ id: 'new-share-id' }));

      const result = await service.createShare('user-uuid-1', {
        targetType: 'file',
        targetId: 'file-uuid-1',
      });

      expect(result.token).toBeDefined();
      expect(result.url).toContain('/s/');
      expect(result.id).toBe('new-share-id');
      expect(auditService.log).toHaveBeenCalled();
    });

    it('文件不存在或无权分享时应抛出 NotFoundException', async () => {
      fileRepo.findOne.mockResolvedValue(null);

      await expect(
        service.createShare('user-uuid-1', {
          targetType: 'file',
          targetId: 'nonexistent',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('带密码的分享应正确哈希存储', async () => {
      fileRepo.findOne.mockResolvedValue(makeFile());
      shareLinkRepo.findOne.mockResolvedValue(null);
      shareLinkRepo.save.mockImplementation((link: ShareLink) =>
        Promise.resolve({ ...link, id: 'new-share-id' }),
      );

      const result = await service.createShare('user-uuid-1', {
        targetType: 'file',
        targetId: 'file-uuid-1',
        password: 'secret123',
      });

      expect(result.token).toBeDefined();
      // 验证保存的 link 中 password 是 bcrypt hash（非明文）
      const savedCall = shareLinkRepo.save.mock.calls[0][0];
      expect(savedCall.password).not.toBe('secret123');
      expect(savedCall.password).toMatch(/^\$2/);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  getSharePublicInfo()
  // ═══════════════════════════════════════════════════════════
  describe('getSharePublicInfo', () => {
    it('无密码分享应直接返回文件元数据', async () => {
      const link = makeShareLink({ password: null });
      shareLinkRepo.findOne.mockResolvedValue(link);
      fileRepo.findOne.mockResolvedValue(makeFile());

      const result = await service.getSharePublicInfo('testtoken123');

      expect(result.requiresPassword).toBe(false);
      expect((result as any).targetType).toBe('file');
    });

    it('有密码但无 JWT 应返回 requiresPassword 且不查询 target', async () => {
      const link = makeShareLink({ password: 'hashed-pwd' });
      shareLinkRepo.findOne.mockResolvedValue(link);

      const result = await service.getSharePublicInfo('testtoken123');

      expect(result.requiresPassword).toBe(true);
      // 不应查询 fileRepo（防止元数据泄露）
      expect(fileRepo.findOne).not.toHaveBeenCalled();
    });

    it('有密码且有有效 JWT 应返回文件元数据', async () => {
      const link = makeShareLink({ password: 'hashed-pwd' });
      shareLinkRepo.findOne.mockResolvedValue(link);
      passwordService.verifyAccessJwt.mockResolvedValue(true);
      fileRepo.findOne.mockResolvedValue(makeFile());

      const result = await service.getSharePublicInfo('testtoken123', 'valid-jwt');

      expect(result.requiresPassword).toBe(false);
    });

    it('有密码但 JWT 无效应返回 requiresPassword', async () => {
      const link = makeShareLink({ password: 'hashed-pwd' });
      shareLinkRepo.findOne.mockResolvedValue(link);
      passwordService.verifyAccessJwt.mockResolvedValue(false);

      const result = await service.getSharePublicInfo('testtoken123', 'invalid-jwt');

      expect(result.requiresPassword).toBe(true);
    });

    it('分享不存在时应抛出 NotFoundException', async () => {
      shareLinkRepo.findOne.mockResolvedValue(null);

      await expect(service.getSharePublicInfo('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('已取消的分享应抛出 NotFoundException', async () => {
      const link = makeShareLink({ isDeleted: true });
      shareLinkRepo.findOne.mockResolvedValue(link);

      await expect(service.getSharePublicInfo('testtoken123')).rejects.toThrow(NotFoundException);
    });

    it('已过期的分享应抛出 NotFoundException', async () => {
      const past = new Date(Date.now() - 2 * 3600 * 1000);
      const link = makeShareLink({
        expiresIn: 1,
        expiresStartAt: past,
      });
      shareLinkRepo.findOne.mockResolvedValue(link);

      await expect(service.getSharePublicInfo('testtoken123')).rejects.toThrow('分享已过期');
    });

    it('访问次数耗尽的分享应抛出 NotFoundException', async () => {
      const link = makeShareLink({
        maxAccessCount: 5,
        currentAccessCount: 5,
      });
      shareLinkRepo.findOne.mockResolvedValue(link);

      await expect(service.getSharePublicInfo('testtoken123')).rejects.toThrow('访问次数已耗尽');
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  verifyPassword()
  // ═══════════════════════════════════════════════════════════
  describe('verifyPassword', () => {
    it('正确密码应返回 accessJwt', async () => {
      const hashedPassword = await bcrypt.hash('secret123', BCRYPT_ROUNDS);
      const link = makeShareLink({ password: hashedPassword });
      shareLinkRepo.findOne.mockResolvedValue(link);

      const result = await service.verifyPassword('testtoken123', 'secret123', '127.0.0.1');

      expect(result.accessJwt).toBe('mock-access-jwt');
      expect(passwordService.issueAccessJwt).toHaveBeenCalledWith(link.id);
    });

    it('错误密码应抛出 BadRequestException 并记录失败尝试', async () => {
      const hashedPassword = await bcrypt.hash('secret123', BCRYPT_ROUNDS);
      const link = makeShareLink({ password: hashedPassword });
      shareLinkRepo.findOne.mockResolvedValue(link);

      await expect(
        service.verifyPassword('testtoken123', 'wrong-password', '127.0.0.1'),
      ).rejects.toThrow(BadRequestException);

      expect(passwordService.recordFailedAttempt).toHaveBeenCalledWith('127.0.0.1');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failure' }),
      );
    });

    it('分享不存在时应抛出 NotFoundException', async () => {
      shareLinkRepo.findOne.mockResolvedValue(null);

      await expect(
        service.verifyPassword('nonexistent', 'secret123', '127.0.0.1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('IP 已被封禁应抛出 ForbiddenException', async () => {
      const hashedPassword = await bcrypt.hash('secret123', BCRYPT_ROUNDS);
      const link = makeShareLink({ password: hashedPassword });
      shareLinkRepo.findOne.mockResolvedValue(link);
      passwordService.isIPBanned.mockResolvedValue({
        banned: true,
        message: 'IP 已被封禁',
      });

      await expect(
        service.verifyPassword('testtoken123', 'secret123', '127.0.0.1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('无密码分享调用此接口应抛出 BadRequestException', async () => {
      const link = makeShareLink({ password: null });
      shareLinkRepo.findOne.mockResolvedValue(link);

      await expect(
        service.verifyPassword('testtoken123', 'secret123', '127.0.0.1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  getShareDownloadStream()
  // ═══════════════════════════════════════════════════════════
  describe('getShareDownloadStream', () => {
    it('无密码分享应成功返回下载流', async () => {
      const link = makeShareLink({ password: null });
      shareLinkRepo.findOne.mockResolvedValue(link);

      const result = await service.getShareDownloadStream(
        'testtoken123',
        'file-uuid-1',
        undefined,
        '127.0.0.1',
      );

      expect(result.stream).toBeDefined();
      expect(result.filename).toBe('document.pdf');
      expect(fileService.getStreamForShareDownload).toHaveBeenCalledWith('file-uuid-1', '127.0.0.1');
    });

    it('有密码但无 JWT 应抛出 ForbiddenException', async () => {
      const link = makeShareLink({ password: 'hashed-pwd' });
      shareLinkRepo.findOne.mockResolvedValue(link);

      await expect(
        service.getShareDownloadStream('testtoken123', 'file-uuid-1', undefined, '127.0.0.1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('有密码且 JWT 无效应抛出 ForbiddenException', async () => {
      const link = makeShareLink({ password: 'hashed-pwd' });
      shareLinkRepo.findOne.mockResolvedValue(link);
      passwordService.verifyAccessJwt.mockResolvedValue(false);

      await expect(
        service.getShareDownloadStream('testtoken123', 'file-uuid-1', 'invalid-jwt', '127.0.0.1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('文件不属于此分享应抛出 ForbiddenException', async () => {
      const link = makeShareLink({ password: null, targetId: 'file-uuid-1' });
      shareLinkRepo.findOne.mockResolvedValue(link);

      await expect(
        service.getShareDownloadStream('testtoken123', 'other-file-id', undefined, '127.0.0.1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('分享不存在时应抛出 NotFoundException', async () => {
      shareLinkRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getShareDownloadStream('nonexistent', 'file-uuid-1', undefined, null),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  cancelShare()
  // ═══════════════════════════════════════════════════════════
  describe('cancelShare', () => {
    it('应成功取消分享', async () => {
      const link = makeShareLink();
      shareLinkRepo.findOne.mockResolvedValue(link);
      shareLinkRepo.save.mockResolvedValue(link);

      await service.cancelShare('share-uuid-1', 'user-uuid-1');

      expect(link.isDeleted).toBe(true);
      expect(link.status).toBe(ShareLinkStatus.DISABLED);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'share_link_delete' }),
      );
    });

    it('分享不存在时应抛出 NotFoundException', async () => {
      shareLinkRepo.findOne.mockResolvedValue(null);

      await expect(service.cancelShare('nonexistent', 'user-uuid-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  listMyShares()
  // ═══════════════════════════════════════════════════════════
  describe('listMyShares', () => {
    it('应返回分页结果并隐藏密码哈希', async () => {
      const links = [
        makeShareLink({ id: 'share-1', password: 'hashed-pwd' }),
        makeShareLink({ id: 'share-2', password: null }),
      ];
      shareLinkRepo.findAndCount.mockResolvedValue([links, 2]);

      const result = await service.listMyShares('user-uuid-1', { page: 1, limit: 10 });

      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
      // 密码哈希不应出现在输出中
      expect((result.items[0] as any).password).toBeUndefined();
      expect(result.items[0].hasPassword).toBe(true);
      expect(result.items[1].hasPassword).toBe(false);
    });

    it('应支持按 targetType 过滤', async () => {
      shareLinkRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.listMyShares('user-uuid-1', { targetType: ShareTargetType.FOLDER });

      const callArgs = shareLinkRepo.findAndCount.mock.calls[0][0];
      expect(callArgs.where.targetType).toBe(ShareTargetType.FOLDER);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  updateShare()
  // ═══════════════════════════════════════════════════════════
  describe('updateShare', () => {
    it('应成功更新密码', async () => {
      const link = makeShareLink({ password: null });
      shareLinkRepo.findOne.mockResolvedValue(link);
      shareLinkRepo.save.mockImplementation((l: ShareLink) => Promise.resolve(l));

      const result = await service.updateShare('share-uuid-1', 'user-uuid-1', {
        password: 'newpassword',
      });

      expect(result.hasPassword).toBe(true);
      expect((result as any).password).toBeUndefined();
    });

    it('应成功清除密码（设为空字符串）', async () => {
      const link = makeShareLink({ password: 'old-hash' });
      shareLinkRepo.findOne.mockResolvedValue(link);
      shareLinkRepo.save.mockImplementation((l: ShareLink) => Promise.resolve(l));

      const result = await service.updateShare('share-uuid-1', 'user-uuid-1', {
        password: '',
      });

      expect(result.hasPassword).toBe(false);
    });

    it('EXHAUSTED 状态在调大上限后应复位为 ACTIVE', async () => {
      const link = makeShareLink({
        maxAccessCount: 5,
        currentAccessCount: 5,
        status: ShareLinkStatus.EXHAUSTED,
      });
      shareLinkRepo.findOne.mockResolvedValue(link);
      shareLinkRepo.save.mockImplementation((l: ShareLink) => Promise.resolve(l));

      const result = await service.updateShare('share-uuid-1', 'user-uuid-1', {
        maxAccessCount: 100,
      });

      expect(result.status).toBe(ShareLinkStatus.ACTIVE);
    });

    it('分享不存在时应抛出 NotFoundException', async () => {
      shareLinkRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateShare('nonexistent', 'user-uuid-1', { password: 'new' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  getShareLinkByToken()
  // ═══════════════════════════════════════════════════════════
  describe('getShareLinkByToken', () => {
    it('应返回分享链接', async () => {
      const link = makeShareLink();
      shareLinkRepo.findOne.mockResolvedValue(link);

      const result = await service.getShareLinkByToken('testtoken123');
      expect(result).toEqual(link);
    });

    it('分享不存在时应抛出 NotFoundException', async () => {
      shareLinkRepo.findOne.mockResolvedValue(null);

      await expect(service.getShareLinkByToken('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  getShareById()
  // ═══════════════════════════════════════════════════════════
  describe('getShareById', () => {
    it('应返回脱敏后的分享链接（无密码）', async () => {
      const link = makeShareLink({ password: null });
      shareLinkRepo.findOne.mockResolvedValue(link);

      const result = await service.getShareById('share-uuid-1', 'user-uuid-1');
      expect((result as any).hasPassword).toBe(false);
      expect((result as any).password).toBeUndefined();
    });

    it('有密码时 hasPassword 应为 true 且不泄漏哈希', async () => {
      const link = makeShareLink({ password: 'bcrypt-hash' });
      shareLinkRepo.findOne.mockResolvedValue(link);

      const result = await service.getShareById('share-uuid-1', 'user-uuid-1');
      expect((result as any).hasPassword).toBe(true);
      expect((result as any).password).toBeUndefined();
    });

    it('分享不存在时应抛出 NotFoundException', async () => {
      shareLinkRepo.findOne.mockResolvedValue(null);
      await expect(service.getShareById('nonexistent', 'user-uuid-1'))
        .rejects.toThrow(NotFoundException);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  assertShareUsablePublic()
  // ═══════════════════════════════════════════════════════════
  describe('assertShareUsablePublic', () => {
    it('正常链接应通过校验', async () => {
      const link = makeShareLink({ status: ShareLinkStatus.ACTIVE });
      await expect(service.assertShareUsablePublic(link)).resolves.toBeUndefined();
    });

    it('已删除链接应抛出 NotFoundException', async () => {
      const link = makeShareLink({ isDeleted: true });
      await expect(service.assertShareUsablePublic(link)).rejects.toThrow(NotFoundException);
    });

    it('已禁用链接应抛出 NotFoundException', async () => {
      const link = makeShareLink({ status: ShareLinkStatus.DISABLED });
      await expect(service.assertShareUsablePublic(link)).rejects.toThrow(NotFoundException);
    });

    it('已过期链接应抛出 NotFoundException 并更新状态', async () => {
      const past = new Date(Date.now() - 2 * 3600 * 1000);
      const link = makeShareLink({ expiresIn: 1, expiresStartAt: past });
      shareLinkRepo.save.mockResolvedValue(undefined);

      await expect(service.assertShareUsablePublic(link)).rejects.toThrow('分享已过期');
      expect(link.status).toBe(ShareLinkStatus.EXPIRED);
    });

    it('访问次数耗尽应抛出 NotFoundException 并更新状态', async () => {
      const link = makeShareLink({ maxAccessCount: 5, currentAccessCount: 5 });
      shareLinkRepo.save.mockResolvedValue(undefined);

      await expect(service.assertShareUsablePublic(link)).rejects.toThrow('分享访问次数已耗尽');
      expect(link.status).toBe(ShareLinkStatus.EXHAUSTED);
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  verifyAccessJwtForLink()
  // ═══════════════════════════════════════════════════════════
  describe('verifyAccessJwtForLink', () => {
    it('JWT 有效时应返回 true', async () => {
      passwordService.verifyAccessJwt.mockResolvedValue(true);
      const link = makeShareLink();

      const result = await service.verifyAccessJwtForLink(link, 'valid-jwt');
      expect(result).toBe(true);
      expect(passwordService.verifyAccessJwt).toHaveBeenCalledWith('valid-jwt', link.id);
    });

    it('JWT 无效时应返回 false', async () => {
      passwordService.verifyAccessJwt.mockResolvedValue(false);
      const link = makeShareLink();

      const result = await service.verifyAccessJwtForLink(link, 'invalid-jwt');
      expect(result).toBe(false);
    });
  });
});

