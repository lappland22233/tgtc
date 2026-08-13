import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, TreeRepository } from 'typeorm';
import { ShareLink, ShareTargetType } from '../common/entities/share-link.entity';
import { File } from '../common/entities/file.entity';
import { Folder } from '../common/entities/folder.entity';
import { AuditService } from '../common/services/audit.service';
import { AuditAction } from '../common/entities/audit-log.entity';

/** 计算过期时间；null 表示永久。分享文件与文件夹元数据共用。 */
export function computeShareExpiry(link: ShareLink): string | null {
  if (!link.expiresIn || !link.expiresStartAt) return null;
  const expiresAt = new Date(link.expiresStartAt.getTime() + link.expiresIn * 3600 * 1000);
  return expiresAt.toISOString();
}

/**
 * 分享文件夹访问与浏览服务（Phase 2 职责拆分）。
 *
 * 承担文件夹分享的子树校验、内容列表与面包屑查询，从 ShareService 中拆出：
 * - isFolderInSubtree：闭包表 EXISTS 半连接判断归属
 * - assertFileInShare：文件分享/文件夹分享的文件归属校验
 * - listFolderContentsForShare / getFolderBreadcrumbForShare / getFolderInfoForShare
 *
 * ShareService 通过依赖注入复用本服务，Controller 仍只面向 ShareService。
 */
@Injectable()
export class ShareFolderBrowseService {
  constructor(
    @InjectRepository(File)
    private readonly fileRepo: Repository<File>,
    @InjectRepository(Folder)
    private readonly folderRepo: TreeRepository<Folder>,
    private readonly audit: AuditService,
  ) {}

  /**
   * 校验 fileId 是否属于此分享的 target 子树。
   * - targetType=FILE：fileId 必须等于 targetId。
   * - targetType=FOLDER：file 所在的 folderId 必须是 target 的后代（或就是 target 自身），
   *   通过闭包表 folder_closure 一次查询得到完整子树 id 列表后判断。
   */
  async assertFileInShare(link: ShareLink, fileId: string): Promise<void> {
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
    const inSubtree = await this.isFolderInSubtree(link.targetId, file.folderId);
    if (!inSubtree) {
      throw new ForbiddenException('文件不在此分享的文件夹下');
    }
  }

  /**
   * 判断 folderId 是否在 targetFolderId 的子树内（含自身）。
   * 用闭包表 EXISTS 半连接，数据库侧完成判断，避免把整棵子树 ID 拉进内存再 includes。
   */
  async isFolderInSubtree(targetFolderId: string, folderId: string): Promise<boolean> {
    const rows = await this.folderRepo.manager.query(
      `SELECT 1 FROM folder_closure WHERE id_ancestor = $1 AND id_descendant = $2 LIMIT 1`,
      [targetFolderId, folderId],
    );
    return rows.length > 0;
  }

  /** 文件夹分享：返回根文件夹信息 + 根级内容（子文件夹 + 文件） */
  async getFolderInfoForShare(link: ShareLink) {
    const root = await this.folderRepo.findOne({ where: { id: link.targetId, isDeleted: false } });
    if (!root) throw new NotFoundException('文件夹已被删除');

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
      const inSubtree = await this.isFolderInSubtree(link.targetId, folderId);
      if (!inSubtree) {
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
        select: ['id', 'originalName', 'mimeType', 'size', 'createdAt', 'uploadVersion', 'status'],
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
        // 覆盖上传时递增，供前端做进度记录版本校验
        uploadVersion: f.uploadVersion,
        status: f.status,
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
    const inSubtree = await this.isFolderInSubtree(link.targetId, folderId);
    if (!inSubtree) {
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
}
