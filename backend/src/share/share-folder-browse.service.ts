import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ShareLink, ShareTargetType } from '../common/entities/share-link.entity';
import { File } from '../common/entities/file.entity';
import { Folder } from '../common/entities/folder.entity';
import { AuditService } from '../common/services/audit.service';
import { AuditAction } from '../common/entities/audit-log.entity';

/** 与文件夹服务保持一致，防止损坏数据的 parentId 链造成无限查询。 */
const MAX_SHARE_FOLDER_DEPTH = 20;

/** 计算过期时间；null 表示永久。分享文件与文件夹元数据共用。 */
export function computeShareExpiry(link: ShareLink): string | null {
  if (!link.expiresIn || !link.expiresStartAt) return null;
  const expiresAt = new Date(link.expiresStartAt.getTime() + link.expiresIn * 3600 * 1000);
  return expiresAt.toISOString();
}

/**
 * 分享文件夹访问与浏览服务。
 *
 * 文件夹分享的授权和面包屑均沿 parentId 逐级上溯，不使用 folder_closure 或
 * TreeRepository.findAncestors：闭包表缺失、过期或错误时不能成为授权依据。
 */
@Injectable()
export class ShareFolderBrowseService {
  constructor(
    @InjectRepository(File)
    private readonly fileRepo: Repository<File>,
    @InjectRepository(Folder)
    private readonly folderRepo: Repository<Folder>,
    private readonly audit: AuditService,
  ) {}

  /**
   * 从 folderId 沿 parentId 上溯至分享根，并返回根到当前目录的路径。
   *
   * 每一级都必须存在、未删除且归分享创建者所有；链必须确实到达分享根。
   * 循环、断链或超过最大深度一律视为不属于分享范围，避免损坏数据扩大访问权限。
   */
  private async resolveFolderPathInShare(link: ShareLink, folderId: string): Promise<Folder[]> {
    const seen = new Set<string>();
    const path: Folder[] = [];
    let currentId: string | null = folderId;

    for (let depth = 0; depth <= MAX_SHARE_FOLDER_DEPTH; depth += 1) {
      if (!currentId || seen.has(currentId)) {
        throw new ForbiddenException('文件夹不在此分享的子树内');
      }
      seen.add(currentId);

      const folder = await this.folderRepo.findOne({ where: { id: currentId, isDeleted: false } });
      if (!folder) {
        if (path.length === 0) throw new NotFoundException('文件夹不存在或已被删除');
        throw new ForbiddenException('文件夹不在此分享的子树内');
      }
      if (folder.ownerId !== link.creatorId) {
        throw new ForbiddenException('文件夹不在此分享的子树内');
      }

      path.push(folder);
      if (folder.id === link.targetId) return path.reverse();
      currentId = folder.parentId;
    }

    throw new ForbiddenException('文件夹不在此分享的子树内');
  }

  /**
   * 校验 fileId 是否属于此分享的 target 子树。
   * - targetType=FILE：fileId 必须等于 targetId。
   * - targetType=FOLDER：文件及其所在目录必须归分享创建者所有，且目录 parentId 链必须到达分享根。
   */
  async assertFileInShare(link: ShareLink, fileId: string): Promise<void> {
    if (link.targetType === ShareTargetType.FILE) {
      if (fileId !== link.targetId) {
        throw new ForbiddenException('文件不属于此分享');
      }
      return;
    }

    const file = await this.fileRepo.findOne({ where: { id: fileId, isDeleted: false } });
    if (!file) throw new NotFoundException('文件不存在');
    if (!file.folderId || file.uploaderId !== link.creatorId) {
      throw new ForbiddenException('文件不在此分享的文件夹下');
    }

    try {
      await this.resolveFolderPathInShare(link, file.folderId);
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ForbiddenException) {
        throw new ForbiddenException('文件不在此分享的文件夹下');
      }
      throw error;
    }
  }

  /**
   * 兼容保留的结构性判断。该方法不用于分享授权；授权必须使用
   * resolveFolderPathInShare，以便同时校验每级 ownerId 与 isDeleted。
   */
  async isFolderInSubtree(targetFolderId: string, folderId: string): Promise<boolean> {
    const seen = new Set<string>();
    let currentId: string | null = folderId;

    for (let depth = 0; depth <= MAX_SHARE_FOLDER_DEPTH; depth += 1) {
      if (!currentId || seen.has(currentId)) return false;
      seen.add(currentId);
      const folder = await this.folderRepo.findOne({ where: { id: currentId, isDeleted: false } });
      if (!folder) return false;
      if (folder.id === targetFolderId) return true;
      currentId = folder.parentId;
    }
    return false;
  }

  /** 文件夹分享：返回根文件夹信息 + 根级内容（子文件夹 + 文件） */
  async getFolderInfoForShare(link: ShareLink) {
    const [root] = await this.resolveFolderPathInShare(link, link.targetId);
    const contents = await this.listFolderContentsForShare(link, root.id);
    const expiresAt = computeShareExpiry(link);
    return {
      requiresPassword: false,
      targetType: 'folder' as const,
      folderInfo: {
        id: root.id,
        name: root.name,
        createdAt: root.createdAt,
        expiresAt,
      },
      contents,
      breadcrumb: [{ id: root.id, name: root.name }],
    };
  }

  /**
   * 断言 folderId 属于分享 target 子树（含分享根），且整条 parentId 链安全有效。
   * 此方法在消费访问配额前调用，避免无效请求消耗配额。
   */
  async assertFolderInShare(link: ShareLink, folderId: string): Promise<void> {
    await this.resolveFolderPathInShare(link, folderId);
  }

  /**
   * 列出文件夹分享中指定子文件夹的内容（子文件夹 + 文件）。
   * 文件按 page/limit 分页，limit 上限为 100。
   */
  async listFolderContentsForShare(
    link: ShareLink,
    folderId: string,
    options: { page?: number; limit?: number } = {},
  ) {
    await this.assertFolderInShare(link, folderId);

    const page = Math.max(1, Math.floor(options.page ?? 1));
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 100)));
    const [subfolders, files, totalFiles] = await Promise.all([
      this.folderRepo.find({
        where: { ownerId: link.creatorId, parentId: folderId, isDeleted: false },
        order: { name: 'ASC' },
        select: ['id', 'name', 'createdAt', 'parentId'],
      }),
      this.fileRepo.find({
        where: { uploaderId: link.creatorId, folderId, isDeleted: false },
        order: { originalName: 'ASC' },
        select: ['id', 'originalName', 'mimeType', 'size', 'createdAt', 'uploadVersion', 'status'],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.fileRepo.count({ where: { uploaderId: link.creatorId, folderId, isDeleted: false } }),
    ]);

    this.audit.log({
      action: 'share_link_access' as AuditAction,
      resourceType: 'share_link',
      resourceId: link.id,
      metadata: { browseFolderId: folderId, subfolderCount: subfolders.length, fileCount: files.length, totalFiles },
    });

    return {
      subfolders: subfolders.map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt })),
      files: files.map((f) => ({
        id: f.id,
        name: f.originalName,
        size: Number(f.size),
        mimeType: f.mimeType,
        createdAt: f.createdAt,
        uploadVersion: f.uploadVersion,
        status: f.status,
        downloadUrl: `/api/s/${link.token}/download/${f.id}`,
      })),
      pagination: { page, limit, total: totalFiles, hasMore: page * limit < totalFiles },
    };
  }

  /** 返回从分享根文件夹到当前 folderId 的安全面包屑。 */
  async getFolderBreadcrumbForShare(link: ShareLink, folderId: string) {
    const path = await this.resolveFolderPathInShare(link, folderId);
    return path.map((folder) => ({ id: folder.id, name: folder.name }));
  }
}
