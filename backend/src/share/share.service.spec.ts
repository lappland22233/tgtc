import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Readable } from 'stream';
import { ShareService } from './share.service';
import { ShareLink, ShareLinkStatus, ShareTargetType } from '../common/entities/share-link.entity';
import { File } from '../common/entities/file.entity';

/**
 * L6/N2 回归：分享主服务（share.service.ts）此前 749 行核心逻辑零单测，
 * 密码校验、访问次数原子扣减、过期判断、目标解析全部集中在该文件。
 * 本套件覆盖上述边界，避免「测试全过但分享约束已失效」。
 */

const shareId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const fileId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const creatorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const otherUserId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** 用真实 bcrypt（低轮数，测试提速）生成可比对哈希。 */
const passwordHash = bcrypt.hashSync('correct-horse', 4);

function makeLink(overrides: Partial<ShareLink> = {}): ShareLink {
  return Object.assign(new ShareLink(), {
    id: shareId,
    token: 'tok123456789',
    targetType: ShareTargetType.FILE,
    targetId: fileId,
    creatorId,
    password: null,
    maxAccessCount: -1,
    currentAccessCount: 0,
    expiresIn: null,
    expiresStartAt: null,
    status: ShareLinkStatus.ACTIVE,
    isDeleted: false,
    ...overrides,
  });
}

function makeFile(): File {
  return Object.assign(new File(), {
    id: fileId,
    originalName: 'report.pdf',
    mimeType: 'application/pdf',
    size: 1234,
    uploadVersion: 1,
    isDeleted: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
}

function makeQueryBuilder(affected: number) {
  const builder: Record<string, jest.Mock> = {} as Record<string, jest.Mock>;
  builder.update = jest.fn(() => builder);
  builder.set = jest.fn(() => builder);
  builder.where = jest.fn(() => builder);
  builder.andWhere = jest.fn(() => builder);
  builder.execute = jest.fn(async () => ({ affected }));
  return builder;
}

describe('ShareService（L6/N2）', () => {
  let service: ShareService;
  let shareLinkRepo: any;
  let fileRepo: any;
  let folderRepo: any;
  let audit: { log: jest.Mock; logAwait: jest.Mock };
  let passwordService: any;
  let previewSessionService: any;
  let folderBrowse: any;
  let fileService: any;
  let qbAffected: number;

  beforeEach(() => {
    qbAffected = 1;
    shareLinkRepo = {
      findOne: jest.fn(),
      create: jest.fn((data: Partial<ShareLink>) => Object.assign(new ShareLink(), data)),
      save: jest.fn(async (entity: ShareLink) => entity),
      update: jest.fn(async () => ({ affected: 1 })),
      createQueryBuilder: jest.fn(() => makeQueryBuilder(qbAffected)),
    };
    fileRepo = { findOne: jest.fn() };
    folderRepo = { findOne: jest.fn() };
    audit = { log: jest.fn(), logAwait: jest.fn() };
    passwordService = {
      checkPasswordAttemptAllowed: jest.fn(async () => true),
      isIPBanned: jest.fn(async () => ({ banned: false })),
      recordFailedAttempt: jest.fn(async () => undefined),
      recordTokenFailedAttempt: jest.fn(async () => undefined),
      issueAccessJwt: jest.fn(async () => 'signed-access-jwt'),
      verifyAccessJwt: jest.fn(async () => true),
    };
    previewSessionService = { consumePreviewAccess: jest.fn(async () => 'consumed') };
    folderBrowse = {
      getFolderInfoForShare: jest.fn(async () => ({ requiresPassword: false, targetType: 'folder', items: [] })),
      assertFileInShare: jest.fn(async () => undefined),
      listFolderContentsForShare: jest.fn(async () => ({ items: [] })),
      assertFolderInShare: jest.fn(async () => undefined),
      getFolderBreadcrumbForShare: jest.fn(async () => []),
    };
    fileService = {
      getStreamForShareDownload: jest.fn(async () => ({
        stream: Readable.from('x'),
        contentType: 'application/pdf',
        filename: 'report.pdf',
        size: 1234,
        isInline: false,
      })),
      getShareDownloadStreamWithRange: jest.fn(async () => null),
      getSharePreviewStreamWithRange: jest.fn(async () => null),
    };

    service = new ShareService(
      shareLinkRepo,
      fileRepo,
      folderRepo,
      audit as any,
      passwordService,
      fileService,
      { get: jest.fn(() => 'https://files.example.com') } as any,
      previewSessionService,
      folderBrowse,
    );
  });

  // ---------- getSharePublicInfo：严格模式与状态 ----------

  describe('getSharePublicInfo', () => {
    it('有密码且未携带 accessJwt 时只返回 requiresPassword，且不查询目标资源', async () => {
      shareLinkRepo.findOne.mockResolvedValue(makeLink({ password: passwordHash }));

      const result = await service.getSharePublicInfo('tok123456789');

      expect(result).toEqual({ requiresPassword: true });
      expect(fileRepo.findOne).not.toHaveBeenCalled();
      expect(folderBrowse.getFolderInfoForShare).not.toHaveBeenCalled();
    });

    it('accessJwt 校验失败时同样不泄露目标资源', async () => {
      shareLinkRepo.findOne.mockResolvedValue(makeLink({ password: passwordHash }));
      passwordService.verifyAccessJwt.mockResolvedValue(false);

      const result = await service.getSharePublicInfo('tok123456789', 'bad-jwt');

      expect(result).toEqual({ requiresPassword: true });
      expect(fileRepo.findOne).not.toHaveBeenCalled();
    });

    it('无密码文件分享返回文件元数据与下载地址', async () => {
      shareLinkRepo.findOne.mockResolvedValue(makeLink());
      fileRepo.findOne.mockResolvedValue(makeFile());

      const result = await service.getSharePublicInfo('tok123456789');

      expect(result).toMatchObject({
        requiresPassword: false,
        targetType: 'file',
        fileInfo: { id: fileId, name: 'report.pdf', size: 1234 },
      });
      expect((result as any).downloadUrl).toContain(`/api/s/tok123456789/download/${fileId}`);
    });

    it('文件夹分享委托给 folderBrowse', async () => {
      shareLinkRepo.findOne.mockResolvedValue(makeLink({ targetType: ShareTargetType.FOLDER }));
      folderBrowse.getFolderInfoForShare.mockResolvedValue({ requiresPassword: false, targetType: 'folder', name: 'docs' });

      const result = await service.getSharePublicInfo('tok123456789');

      expect(folderBrowse.getFolderInfoForShare).toHaveBeenCalled();
      expect(result).toMatchObject({ targetType: 'folder', name: 'docs' });
    });

    it('token 不存在返回 404', async () => {
      shareLinkRepo.findOne.mockResolvedValue(null);
      await expect(service.getSharePublicInfo('missing')).rejects.toThrow(NotFoundException);
    });

    it('超过有效期返回 404 并将状态落为 EXPIRED', async () => {
      const link = makeLink({ expiresIn: 1, expiresStartAt: new Date(Date.now() - 2 * 3600 * 1000) });
      shareLinkRepo.findOne.mockResolvedValue(link);

      await expect(service.getSharePublicInfo('tok123456789')).rejects.toThrow('分享已过期');
      expect(link.status).toBe(ShareLinkStatus.EXPIRED);
      expect(shareLinkRepo.save).toHaveBeenCalled();
    });

    it('访问次数耗尽返回 404 并将状态落为 EXHAUSTED', async () => {
      const link = makeLink({ maxAccessCount: 3, currentAccessCount: 3 });
      shareLinkRepo.findOne.mockResolvedValue(link);

      await expect(service.getSharePublicInfo('tok123456789')).rejects.toThrow('分享访问次数已耗尽');
      expect(link.status).toBe(ShareLinkStatus.EXHAUSTED);
    });

    it('已取消（DISABLED）返回 404', async () => {
      shareLinkRepo.findOne.mockResolvedValue(makeLink({ status: ShareLinkStatus.DISABLED }));
      await expect(service.getSharePublicInfo('tok123456789')).rejects.toThrow('分享已取消或不可用');
    });
  });

  // ---------- verifyPassword：爆破防护与密码校验 ----------

  describe('verifyPassword', () => {
    it('预检不通过时直接拒绝，且不查询分享（避免无效计算）', async () => {
      passwordService.checkPasswordAttemptAllowed.mockResolvedValue(false);

      await expect(service.verifyPassword('tok123456789', 'x', '1.2.3.4')).rejects.toThrow(BadRequestException);
      expect(shareLinkRepo.findOne).not.toHaveBeenCalled();
    });

    it('IP 被封禁时拒绝', async () => {
      shareLinkRepo.findOne.mockResolvedValue(makeLink({ password: passwordHash }));
      passwordService.isIPBanned.mockResolvedValue({ banned: true });

      await expect(service.verifyPassword('tok123456789', 'x', '1.2.3.4')).rejects.toThrow(BadRequestException);
    });

    it('无密码分享不允许走密码验证接口', async () => {
      shareLinkRepo.findOne.mockResolvedValue(makeLink());
      await expect(service.verifyPassword('tok123456789', 'x', '1.2.3.4')).rejects.toThrow('此分享无需密码');
    });

    it('密码正确时签发 accessJwt 且不记录失败', async () => {
      shareLinkRepo.findOne.mockResolvedValue(makeLink({ password: passwordHash }));

      await expect(service.verifyPassword('tok123456789', 'correct-horse', '1.2.3.4'))
        .resolves.toEqual({ accessJwt: 'signed-access-jwt' });
      expect(passwordService.recordFailedAttempt).not.toHaveBeenCalled();
      expect(passwordService.recordTokenFailedAttempt).not.toHaveBeenCalled();
    });

    it('密码错误时同时记录 IP 维度与 token 维度失败', async () => {
      shareLinkRepo.findOne.mockResolvedValue(makeLink({ password: passwordHash }));

      await expect(service.verifyPassword('tok123456789', 'wrong', '1.2.3.4')).rejects.toThrow(BadRequestException);
      expect(passwordService.recordFailedAttempt).toHaveBeenCalledWith('1.2.3.4');
      expect(passwordService.recordTokenFailedAttempt).toHaveBeenCalledWith('tok123456789');
    });

    it('已过期分享在 bcrypt 比对前即被拒绝（避免对失效 token 枚举密码）', async () => {
      shareLinkRepo.findOne.mockResolvedValue(
        makeLink({ password: passwordHash, expiresIn: 1, expiresStartAt: new Date(Date.now() - 2 * 3600 * 1000) }),
      );

      await expect(service.verifyPassword('tok123456789', 'correct-horse', '1.2.3.4')).rejects.toThrow('分享已过期');
      expect(passwordService.recordFailedAttempt).not.toHaveBeenCalled();
    });
  });

  // ---------- getShareDownloadStream：访问次数原子扣减 ----------

  describe('getShareDownloadStream', () => {
    it('有密码但未携带 accessJwt 时 403', async () => {
      shareLinkRepo.findOne.mockResolvedValue(makeLink({ password: passwordHash }));

      await expect(service.getShareDownloadStream('tok123456789', fileId, undefined, null))
        .rejects.toThrow(ForbiddenException);
      expect(fileService.getStreamForShareDownload).not.toHaveBeenCalled();
    });

    it('原子 UPDATE 未命中（已达上限）时按耗尽处理并拒绝输出字节', async () => {
      qbAffected = 0;
      shareLinkRepo.findOne.mockResolvedValue(makeLink({ maxAccessCount: 1, currentAccessCount: 1 - 1 }));

      await expect(service.getShareDownloadStream('tok123456789', fileId, undefined, null))
        .rejects.toThrow('分享访问次数已耗尽');
      expect(fileService.getStreamForShareDownload).not.toHaveBeenCalled();
    });

    it('校验通过时先校验文件归属再取流', async () => {
      shareLinkRepo.findOne.mockResolvedValue(makeLink());

      const result = await service.getShareDownloadStream('tok123456789', fileId, undefined, '1.2.3.4');

      expect(folderBrowse.assertFileInShare).toHaveBeenCalledWith(expect.anything(), fileId);
      expect(fileService.getStreamForShareDownload).toHaveBeenCalledWith(fileId, '1.2.3.4', 'tok123456789');
      expect(result.filename).toBe('report.pdf');
    });

    it('fileId 不属于该分享子树时拒绝', async () => {
      shareLinkRepo.findOne.mockResolvedValue(makeLink());
      folderBrowse.assertFileInShare.mockRejectedValue(new ForbiddenException('文件不在分享范围内'));

      await expect(service.getShareDownloadStream('tok123456789', fileId, undefined, null))
        .rejects.toThrow(ForbiddenException);
      expect(fileService.getStreamForShareDownload).not.toHaveBeenCalled();
    });

    it('token 不存在返回 404', async () => {
      shareLinkRepo.findOne.mockResolvedValue(null);
      await expect(service.getShareDownloadStream('missing', fileId, undefined, null)).rejects.toThrow(NotFoundException);
    });
  });

  // ---------- consumeSharePreviewAccess ----------

  describe('consumeSharePreviewAccess', () => {
    it('预览会话报告耗尽时抛出 404 并落 EXHAUSTED', async () => {
      const link = makeLink({ maxAccessCount: 1, currentAccessCount: 1 });
      previewSessionService.consumePreviewAccess.mockResolvedValue('exhausted');

      await expect(service.consumeSharePreviewAccess(link, fileId, 'visitor-hash'))
        .rejects.toThrow('分享访问次数已耗尽');
      expect(shareLinkRepo.update).toHaveBeenCalledWith(link.id, { status: ShareLinkStatus.EXHAUSTED });
    });

    it('首次预览时原子启动有效期时钟', async () => {
      const link = makeLink({ expiresIn: 24, expiresStartAt: null });
      await service.consumeSharePreviewAccess(link, fileId, 'visitor-hash');

      expect(shareLinkRepo.createQueryBuilder).toHaveBeenCalled();
      expect(link.expiresStartAt).toBeInstanceOf(Date);
    });
  });

  // ---------- createShare / 跨用户隔离 ----------

  describe('createShare', () => {
    it('目标不属于创建者时拒绝（越权分享负向用例）', async () => {
      fileRepo.findOne.mockResolvedValue(null);

      await expect(service.createShare(otherUserId, {
        targetType: ShareTargetType.FILE,
        targetId: fileId,
      } as any)).rejects.toThrow(NotFoundException);

      // 查询条件必须带 uploaderId 约束，不能仅凭 fileId 命中他人文件
      expect(fileRepo.findOne).toHaveBeenCalledWith({
        where: { id: fileId, uploaderId: otherUserId, isDeleted: false },
      });
    });

    it('成功创建时返回 token/url，且密码以哈希存储、审计只记录 token 前缀', async () => {
      fileRepo.findOne.mockResolvedValue(makeFile());

      const result = await service.createShare(creatorId, {
        targetType: ShareTargetType.FILE,
        targetId: fileId,
        password: 'plain-secret',
      } as any);

      expect(result.url).toBe(`https://files.example.com/s/${result.token}`);
      const saved = shareLinkRepo.save.mock.calls[0][0] as ShareLink;
      expect(saved.password).not.toBe('plain-secret');
      expect(await bcrypt.compare('plain-secret', saved.password as string)).toBe(true);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ tokenPrefix: result.token.slice(0, 4), hasPassword: true }),
      }));
    });
  });

  describe('listMyShares / getShareById', () => {
    it('被软删的分享不出现在列表中（查询条件固定 isDeleted=false）', async () => {
      shareLinkRepo.findAndCount = jest.fn(async () => [[], 0]);

      await service.listMyShares(creatorId);

      expect(shareLinkRepo.findAndCount).toHaveBeenCalledWith(expect.objectContaining({
        where: { creatorId, isDeleted: false },
      }));
    });

    it('他人 id 查询按 creatorId 过滤，返回 404 而非泄露内容', async () => {
      shareLinkRepo.findOne.mockResolvedValue(null);

      await expect(service.getShareById(shareId, otherUserId)).rejects.toThrow(NotFoundException);
      expect(shareLinkRepo.findOne).toHaveBeenCalledWith({
        where: { id: shareId, creatorId: otherUserId, isDeleted: false },
      });
    });

    it('返回结果不暴露 bcrypt 密码哈希', async () => {
      shareLinkRepo.findOne.mockResolvedValue(makeLink({ password: passwordHash }));

      const result = await service.getShareById(shareId, creatorId);

      expect(result).not.toHaveProperty('password');
      expect(result).toMatchObject({ hasPassword: true });
    });
  });
});
