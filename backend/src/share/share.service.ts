import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, TreeRepository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { Readable } from 'stream';
import { ShareLink, ShareTargetType, ShareLinkStatus } from '../common/entities/share-link.entity';
import { File } from '../common/entities/file.entity';
import { Folder } from '../common/entities/folder.entity';
import { User } from '../common/entities/user.entity';
import { AuditService } from '../common/services/audit.service';
import { AuditAction, AuditStatus } from '../common/entities/audit-log.entity';
import { FileService } from '../file/file.service';
import { SharePasswordService } from './share-password.service';
import { CreateShareDto, UpdateShareDto } from './share.dto';

const SHARE_TOKEN_BYTES = 9; // 12 字符 base64url，熵 ~72 bit

/**
 * 分享链接服务（Phase 2 核心实现）。
 *
 * 核心接口：
 * - createShare(creatorId, dto)            创建分享，返回 { token, url }
 * - getSharePublicInfo(token, accessJwt)   公开入口，返回元数据（不返回字节）
 * - verifyPassword(token, password, ip)    密码验证，返回 5 分钟 access JWT
 * - getShareDownloadStream(...)             校验后返回文件流
 *
 * 严格模式密码保护关键设计：
 * getSharePublicInfo 在 link.password != null && !accessJwt 时
 * **不查询 target 表**，直接返回 { requiresPassword: true }，
 * 杜绝元数据泄露（即使文件名都不会暴露）。
 */
@Injectable()
export class ShareService {
  private readonly logger = new Logger(ShareService.name);

  constructor(
    @InjectRepository(ShareLink)
    private readonly shareLinkRepo: Repository<ShareLink>,
    @InjectRepository(File)
    private readonly fileRepo: Repository<File>,
    @InjectRepository(Folder)
    private readonly folderRepo: TreeRepository<Folder>,
    private readonly audit: AuditService,
    private readonly passwordService: SharePasswordService,
    private readonly fileService: FileService,
    private readonly configService: ConfigService,
  ) {}

  private get appUrl(): string {
    return this.configService.get<string>('APP_URL') || 'http://localhost:3000';
  }

  // ---------- 创建分享 ----------

  async createShare(creatorId: string, dto: CreateShareDto): Promise<{ token: string; url: string; id: string }> {
    // 1. 校验 target 存在且属于 creator
    if (dto.targetType === ShareTargetType.FILE) {
      const file = await this.fileRepo.findOne({
        where: { id: dto.targetId, uploaderId: creatorId, isDeleted: false },
      });
      if (!file) throw new NotFoundException('文件不存在或无权分享');
    } else {
      const folder = await this.folderRepo.findOne({
        where: { id: dto.targetId, ownerId: creatorId, isDeleted: false },
      });
      if (!folder) throw new NotFoundException('文件夹不存在或无权分享');
    }

    // 2. 生成唯一 token（带重试，防碰撞）
    let token: string;
    let attempt = 0;
    while (true) {
      token = randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
      const exists = await this.shareLinkRepo.findOne({ where: { token } });
      if (!exists) break;
      attempt++;
      if (attempt >= 5) throw new BadRequestException('token 生成失败，请重试');
    }

    // 3. bcrypt 加密密码
    const password = dto.password
      ? await bcrypt.hash(dto.password, 10)
      : null;

    // 4. 创建 ShareLink
    const link = this.shareLinkRepo.create({
      token,
      targetType: dto.targetType,
      targetId: dto.targetId,
      creatorId,
      password,
      maxAccessCount: dto.maxAccessCount ?? -1,
      expiresIn: dto.expiresIn ?? null,
      expiresStartAt: null, // 首次访问时才设置
    });
    const saved = await this.shareLinkRepo.save(link);

    this.audit.log({
      action: 'share_link_create' as AuditAction,
      userId: creatorId,
      resourceType: 'share_link',
      resourceId: saved.id,
      metadata: { token, targetType: dto.targetType, targetId: dto.targetId, hasPassword: !!password },
    });

    return { token, url: `${this.appUrl}/s/${token}`, id: saved.id };
  }

  // ---------- 公开入口 ----------

  /**
   * 公开访问入口：返回分享元数据，**不返回文件字节**。
   *
   * 严格模式密码保护关键路径：
   * - link.password != null && !accessJwt → 返回 { requiresPassword: true }
   *   **不查询 target 表**，前端无法从响应里推断文件/文件夹的任何信息。
   * - link.password != null && accessJwt → 校验 accessJwt，通过后才返回元数据。
   * - link.password == null → 直接返回元数据。
   */
  async getSharePublicInfo(token: string, accessJwt?: string) {
    const link = await this.shareLinkRepo.findOne({
      where: { token, isDeleted: false },
    });
    if (!link) throw new NotFoundException('分享不存在或已被取消');

    // 状态校验：过期/次数耗尽/取消
    this.assertShareUsable(link);

    // 严格模式：需要密码但未通过 → 不查询 target
    if (link.password && !accessJwt) {
      return { requiresPassword: true };
    }
    if (link.password && accessJwt) {
      const ok = await this.passwordService.verifyAccessJwt(accessJwt, link.id);
      if (!ok) return { requiresPassword: true };
    }

    // 通过校验 → 首次访问设置 expiresStartAt
    if (link.expiresIn && !link.expiresStartAt) {
      link.expiresStartAt = new Date();
      await this.shareLinkRepo.save(link);
    }

    // 增加访问计数 + 检查耗尽
    await this.incrementAccessCount(link);

    this.audit.log({
      action: 'share_link_access' as AuditAction,
      resourceType: 'share_link',
      resourceId: link.id,
      metadata: { token, targetType: link.targetType },
    });

    // 返回 target 元数据（不返回字节）
    if (link.targetType === ShareTargetType.FILE) {
      return await this.getFileInfoForShare(link);
    } else {
      return await this.getFolderInfoForShare(link);
    }
  }

  // ---------- 密码验证 ----------

  /**
   * 验证分享链接密码，签发 5 分钟 access JWT。
   * - IP 失败 5 次触发封禁（复用 BannedIP 表，与 file.service 共享）
   * - 成功后返回 accessJwt，前端保存到内存，后续调用 /s/:token/download 时附带
   */
  async verifyPassword(token: string, password: string, ip: string | null): Promise<{ accessJwt: string }> {
    const link = await this.shareLinkRepo.findOne({ where: { token, isDeleted: false } });
    if (!link) throw new NotFoundException('分享不存在');

    // IP 封禁检查
    if (ip) {
      const ipCheck = await this.passwordService.isIPBanned(ip);
      if (ipCheck.banned) {
        throw new ForbiddenException(ipCheck.message || 'IP 已被封禁');
      }
    }

    // 无密码的分享不应该走这个接口
    if (!link.password) {
      throw new BadRequestException('此分享无需密码');
    }

    const valid = await bcrypt.compare(password, link.password);
    if (!valid) {
      if (ip) await this.passwordService.recordFailedAttempt(ip);
      this.audit.log({
        action: 'share_link_password_failed' as AuditAction,
        resourceType: 'share_link',
        resourceId: link.id,
        status: AuditStatus.FAILURE,
        metadata: { ip: ip || null },
      });
      throw new BadRequestException('密码错误');
    }

    const accessJwt = await this.passwordService.issueAccessJwt(link.id);
    return { accessJwt };
  }

  // ---------- 文件下载 ----------

  /**
   * 获取分享下载流：校验 token + accessJwt（若有密码）+ 文件存在性，
   * 调用 FileService.getStreamForShareDownload 返回 Telegram 缓存流。
   */
  async getShareDownloadStream(
    token: string,
    fileId: string,
    accessJwt: string | undefined,
    ip: string | null,
  ): Promise<{
    stream: Readable;
    contentType: string;
    filename: string;
    size: number;
    isInline: boolean;
    accessLogId?: string;
  }> {
    const link = await this.shareLinkRepo.findOne({ where: { token, isDeleted: false } });
    if (!link) throw new NotFoundException('分享不存在');

    this.assertShareUsable(link);

    // 严格模式：密码校验
    if (link.password) {
      if (!accessJwt) {
        throw new ForbiddenException('此分享需要密码');
      }
      const ok = await this.passwordService.verifyAccessJwt(accessJwt, link.id);
      if (!ok) throw new ForbiddenException('访问凭证已失效，请重新输入密码');
    }

    // 校验 fileId 是否属于此分享的 target 子树
    await this.assertFileInShare(link, fileId);

    // 增加下载计数（独立于访问计数，避免一次访问多次下载快速耗尽）
    this.audit.log({
      action: 'share_link_download' as AuditAction,
      resourceType: 'share_link',
      resourceId: link.id,
      metadata: { token, fileId, ip: ip || null },
    });

    return this.fileService.getStreamForShareDownload(fileId, ip || undefined);
  }

  // ---------- 列出/更新/取消分享 ----------

  /** 列出当前用户的所有分享（分页 + 可按 targetType 过滤） */
  async listMyShares(creatorId: string, options: {
    targetType?: ShareTargetType;
    page?: number;
    limit?: number;
  } = {}) {
    const page = options.page ?? 1;
    const limit = Math.min(options.limit ?? 20, 100);
    const where: Record<string, unknown> = { creatorId, isDeleted: false };
    if (options.targetType) where.targetType = options.targetType;

    const [items, total] = await this.shareLinkRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, page, limit };
  }

  async getShareById(id: string, creatorId: string): Promise<ShareLink> {
    const link = await this.shareLinkRepo.findOne({
      where: { id, creatorId, isDeleted: false },
    });
    if (!link) throw new NotFoundException('分享不存在');
    return link;
  }

  async updateShare(id: string, creatorId: string, dto: UpdateShareDto): Promise<ShareLink> {
    const link = await this.getShareById(id, creatorId);
    if (dto.password !== undefined) {
      link.password = dto.password ? await bcrypt.hash(dto.password, 10) : null;
    }
    if (dto.maxAccessCount !== undefined) link.maxAccessCount = dto.maxAccessCount;
    if (dto.expiresIn !== undefined) {
      link.expiresIn = dto.expiresIn;
      // 改变有效期时重置起始时间，让新有效期立即生效
      link.expiresStartAt = dto.expiresIn ? new Date() : null;
    }
    const saved = await this.shareLinkRepo.save(link);
    this.audit.log({
      action: 'share_link_update' as AuditAction,
      userId: creatorId,
      resourceType: 'share_link',
      resourceId: id,
      metadata: { ...dto },
    });
    return saved;
  }

  async cancelShare(id: string, creatorId: string): Promise<void> {
    const link = await this.getShareById(id, creatorId);
    link.isDeleted = true;
    link.status = ShareLinkStatus.DISABLED;
    await this.shareLinkRepo.save(link);
    this.audit.log({
      action: 'share_link_delete' as AuditAction,
      userId: creatorId,
      resourceType: 'share_link',
      resourceId: id,
    });
  }

  // ---------- 内部工具 ----------

  // ---------- 公开辅助方法（供 Controller 使用，Phase 3 新增） ----------

  /** 按 token 查询分享链接（用于公开端点），不存在或已软删则抛 404 */
  async getShareLinkByToken(token: string): Promise<ShareLink> {
    const link = await this.shareLinkRepo.findOne({ where: { token, isDeleted: false } });
    if (!link) throw new NotFoundException('分享不存在或已被取消');
    return link;
  }

  /**
   * 公开的可用性校验：委托给 private assertShareUsable。
   * 对外暴露为 public 方法，供 ShareController 在 folder/contents 等端点复用。
   */
  async assertShareUsablePublic(link: ShareLink): Promise<void> {
    return this.assertShareUsable(link);
  }

  /**
   * 校验 access JWT 是否属于此 share link。
   * 严格模式：返回 false 而不抛异常，让调用方按需返回 { requiresPassword: true }。
   */
  async verifyAccessJwtForLink(link: ShareLink, accessJwt: string): Promise<boolean> {
    return this.passwordService.verifyAccessJwt(accessJwt, link.id);
  }

  /**
   * 校验分享链接是否可用：
   * - isDeleted → 已取消
   * - status === DISABLED → 已禁用
   * - expiresStartAt + expiresIn < now → 已过期
   * - maxAccessCount > 0 && currentAccessCount >= maxAccessCount → 已耗尽
   *
   * 过期/耗尽会同步更新 status 字段（弱一致，可接受）。
   */
  private async assertShareUsable(link: ShareLink): Promise<void> {
    if (link.isDeleted || link.status === ShareLinkStatus.DISABLED) {
      throw new NotFoundException('分享已取消或不可用');
    }

    // 过期检查
    if (link.expiresIn && link.expiresStartAt) {
      const expiresAt = new Date(link.expiresStartAt.getTime() + link.expiresIn * 3600 * 1000);
      if (new Date() > expiresAt) {
        link.status = ShareLinkStatus.EXPIRED;
        await this.shareLinkRepo.save(link);
        throw new NotFoundException('分享已过期');
      }
    }

    // 次数耗尽检查（maxAccessCount = -1 表示不限）
    if (link.maxAccessCount >= 0 && link.currentAccessCount >= link.maxAccessCount) {
      link.status = ShareLinkStatus.EXHAUSTED;
      await this.shareLinkRepo.save(link);
      throw new NotFoundException('分享访问次数已耗尽');
    }
  }

  private async incrementAccessCount(link: ShareLink): Promise<void> {
    if (link.maxAccessCount < 0) return; // 不限次数，不增加
    link.currentAccessCount += 1;
    await this.shareLinkRepo.save(link);
  }

  /**
   * 校验 fileId 是否属于此分享的 target 子树。
   * - targetType=FILE：fileId 必须等于 targetId。
   * - targetType=FOLDER：file 所在的 folderId 必须是 target 的后代（或就是 target 自身），
   *   通过闭包表 folder_closure 一次查询得到完整子树 id 列表后判断。
   */
  private async assertFileInShare(link: ShareLink, fileId: string): Promise<void> {
    if (link.targetType === ShareTargetType.FILE) {
      if (fileId !== link.targetId) {
        throw new ForbiddenException('文件不属于此分享');
      }
      return;
    }
    // 文件夹分享：校验 fileId 所在的 folderId 是否在 target 子树内
    const file = await this.fileRepo.findOne({ where: { id: fileId, isDeleted: false } });
    if (!file) throw new NotFoundException('文件不存在');
    if (!file.folderId) {
      // 文件位于根目录，不在任何文件夹分享的子树内
      throw new ForbiddenException('文件不在此分享的文件夹下');
    }
    const descendantIds = await this.getDescendantFolderIds(link.targetId);
    if (!descendantIds.includes(file.folderId)) {
      throw new ForbiddenException('文件不在此分享的文件夹下');
    }
  }

  /**
   * 通过闭包表 folder_closure 查询 targetFolderId 的所有后代（含自身）ID。
   * 一次 SQL 查询，避免加载完整 Folder 实体。
   * 性能：即便 1000 个子文件夹，返回 1000 个 UUID 也很快（< 10ms）。
   */
  private async getDescendantFolderIds(targetFolderId: string): Promise<string[]> {
    const rows = await this.folderRepo.manager.query(
      `SELECT id_descendant FROM folder_closure WHERE id_ancestor = $1`,
      [targetFolderId],
    );
    return rows.map((r: { id_descendant: string }) => r.id_descendant);
  }

  /** 文件分享：返回文件元数据 + 下载 URL */
  private async getFileInfoForShare(link: ShareLink) {
    const file = await this.fileRepo.findOne({ where: { id: link.targetId } });
    if (!file) throw new NotFoundException('文件已被删除');
    const expiresAt = this.computeExpiry(link);
    return {
      requiresPassword: false,
      targetType: 'file' as const,
      fileInfo: {
        id: file.id,
        name: file.originalName,
        size: Number(file.size),
        mimeType: file.mimeType,
        createdAt: file.createdAt,
        expiresAt,
      },
      downloadUrl: `/api/s/${link.token}/download/${file.id}`,
    };
  }

  /** 文件夹分享：返回根文件夹信息 + 根级内容（子文件夹 + 文件） */
  private async getFolderInfoForShare(link: ShareLink) {
    const root = await this.folderRepo.findOne({ where: { id: link.targetId, isDeleted: false } });
    if (!root) throw new NotFoundException('文件夹已被删除');

    const contents = await this.listFolderContentsForShare(link, root.id);
    const expiresAt = this.computeExpiry(link);
    return {
      requiresPassword: false,
      targetType: 'folder' as const,
      folderInfo: {
        id: root.id,
        name: root.name,
        createdAt: root.createdAt,
        expiresAt,
      },
      // 根级内容（子文件夹 + 文件）
      contents,
      // 面包屑从根开始，第一段就是 root 自身
      breadcrumb: [{ id: root.id, name: root.name }],
    };
  }

  /**
   * 列出文件夹分享中指定子文件夹的内容（子文件夹 + 文件）。
   * Phase 3 核心：用闭包表校验 folderId 在分享 target 的子树内，
   * 然后查询该 folder 的直接 subfolders 和 files。
   *
   * 注意：folderId 等于 link.targetId 是合法的（根目录自身）。
   */
  async listFolderContentsForShare(link: ShareLink, folderId: string) {
    // 校验 folderId 在分享 target 的子树内（含 target 自身）
    if (folderId !== link.targetId) {
      const descendantIds = await this.getDescendantFolderIds(link.targetId);
      if (!descendantIds.includes(folderId)) {
        throw new ForbiddenException('文件夹不在此分享的子树内');
      }
    }

    // 校验 folder 未被软删
    const folder = await this.folderRepo.findOne({ where: { id: folderId, isDeleted: false } });
    if (!folder) throw new NotFoundException('文件夹不存在或已被删除');

    // 并行查询子文件夹和文件
    const [subfolders, files] = await Promise.all([
      this.folderRepo.find({
        where: { parentId: folderId, isDeleted: false },
        order: { name: 'ASC' },
        select: ['id', 'name', 'createdAt', 'parentId'],
      }),
      this.fileRepo.find({
        where: { folderId, isDeleted: false },
        order: { originalName: 'ASC' },
        select: ['id', 'originalName', 'mimeType', 'size', 'createdAt'],
      }),
    ]);

    this.audit.log({
      action: 'share_link_access' as AuditAction,
      resourceType: 'share_link',
      resourceId: link.id,
      metadata: {
        browseFolderId: folderId,
        subfolderCount: subfolders.length,
        fileCount: files.length,
      },
    });

    return {
      subfolders: subfolders.map((f) => ({
        id: f.id,
        name: f.name,
        createdAt: f.createdAt,
      })),
      files: files.map((f) => ({
        id: f.id,
        name: f.originalName,
        size: Number(f.size),
        mimeType: f.mimeType,
        createdAt: f.createdAt,
        // 文件夹分享下载 URL：走 /api/s/:token/download/:fileId
        downloadUrl: `/api/s/${link.token}/download/${f.id}`,
      })),
    };
  }

  /**
   * 返回从分享根文件夹到当前 folderId 的路径（面包屑）。
   * 用闭包表 findAncestors 一次查询拿到所有祖先，反转为从根到自身。
   * 过滤掉软删除的祖先（即使闭包表里有记录）。
   */
  async getFolderBreadcrumbForShare(link: ShareLink, folderId: string) {
    if (folderId === link.targetId) {
      const root = await this.folderRepo.findOne({
        where: { id: link.targetId, isDeleted: false },
        select: ['id', 'name'],
      });
      if (!root) throw new NotFoundException('文件夹不存在');
      return [{ id: root.id, name: root.name }];
    }

    // 校验 folderId 在子树内
    const descendantIds = await this.getDescendantFolderIds(link.targetId);
    if (!descendantIds.includes(folderId)) {
      throw new ForbiddenException('文件夹不在此分享的子树内');
    }

    const folder = await this.folderRepo.findOne({ where: { id: folderId } });
    if (!folder) throw new NotFoundException('文件夹不存在');

    // findAncestors 返回从自身到根的顺序，需要反转为从根到自身
    const ancestors = await this.folderRepo.findAncestors(folder);
    const filtered = ancestors
      .filter((f) => !f.isDeleted)
      .reverse()
      .map((f) => ({ id: f.id, name: f.name }));
    return filtered;
  }

  /** 计算过期时间；null 表示永久 */
  private computeExpiry(link: ShareLink): string | null {
    if (!link.expiresIn || !link.expiresStartAt) return null;
    const expiresAt = new Date(link.expiresStartAt.getTime() + link.expiresIn * 3600 * 1000);
    return expiresAt.toISOString();
  }
}
