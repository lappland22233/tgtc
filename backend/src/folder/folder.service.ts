import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, TreeRepository, Not, IsNull, In } from 'typeorm';
import { Folder } from '../common/entities/folder.entity';
import { File } from '../common/entities/file.entity';
import { AuditService } from '../common/services/audit.service';
import { AuditAction } from '../common/entities/audit-log.entity';
import { CreateFolderDto, RenameFolderDto, MoveFolderDto, MoveFileDto, RenameFileDto, CopyFileDto } from './folder.dto';

const SOFT_DELETE_GRACE_DAYS = 7;

/** 文件夹最大嵌套深度（根目录子级为 0）。限制层级避免闭包表平方级膨胀与递归栈溢出 */
const MAX_FOLDER_DEPTH = 20;

/**
 * 文件夹服务：网盘层级管理。
 *
 * 设计要点：
 * 1. 所有操作强制校验 ownership（ownerId === user.id），防止跨用户越权。
 * 2. 移动文件夹时检测循环（不能把文件夹移入自己的子树）。
 * 3. 软删除联动子树 + 内含文件，沿用 files 表的 7 天延迟机制。
 * 4. 文件移动到 null folderId = 网盘根目录。
 *
 * 注意：注入 TreeRepository 的方式 —— NestJS @nestjs/typeorm v10 不再导出
 * InjectTreeRepository 装饰器；使用 @InjectRepository + 类型断言，
 * TypeORM 会根据 entity 的 @Tree 装饰器自动返回 TreeRepository 实例。
 */
@Injectable()
export class FolderService {
  constructor(
    @InjectRepository(Folder)
    private readonly folderRepo: TreeRepository<Folder>,
    @InjectRepository(File)
    private readonly fileRepo: Repository<File>,
    private readonly audit: AuditService,
  ) {}

  // ---------- 查询方法 ----------

  /** 列出指定文件夹下的直接子文件夹 */
  async listSubfolders(ownerId: string, parentId: string | null): Promise<Folder[]> {
    if (parentId) {
      await this.assertFolderOwned(parentId, ownerId);
    }
    return this.folderRepo.find({
      where: { ownerId, parentId: parentId ?? IsNull(), isDeleted: false },
      order: { name: 'ASC' },
    });
  }

  /**
   * 构建当前用户的完整文件夹树（递归），用于左侧导航。
   * 单次查询拿到所有未删的 folder，前端在内存里构建树。
   * 用户单账号 folder 数量预期 <5000，O(n) 内存构建可接受。
   */
  async getTree(ownerId: string): Promise<Folder[]> {
    const allFolders = await this.folderRepo.find({
      where: { ownerId, isDeleted: false },
      order: { name: 'ASC' },
    });
    return this.buildTreeFromFlat(allFolders);
  }

  /** 返回从根到当前文件夹的路径（面包屑） */
  async getBreadcrumb(ownerId: string, folderId: string | null): Promise<Folder[]> {
    if (!folderId) return [];
    await this.assertFolderOwned(folderId, ownerId);
    const folder = await this.folderRepo.findOne({ where: { id: folderId } });
    if (!folder) throw new NotFoundException('文件夹不存在');
    // findAncestors 返回顺序是从自身到根，需要反转为从根到自身
    const ancestors = await this.folderRepo.findAncestors(folder);
    return ancestors.reverse().filter((f) => !f.isDeleted);
  }

  /**
   * 列出指定文件夹下的内容（子文件夹 + 文件），用于网盘主区域。
   * 这是网盘用户最常调用的接口，需保证性能。
   */
  async listContents(ownerId: string, folderId: string | null, options: { includeDeleted?: boolean } = {}) {
    if (folderId) {
      await this.assertFolderOwned(folderId, ownerId);
    }
    const fileWhere: Record<string, unknown> = {
      uploaderId: ownerId,
      folderId: folderId ?? IsNull(),
    };
    if (!options.includeDeleted) {
      fileWhere.isDeleted = false;
    }
    const [subfolders, files] = await Promise.all([
      this.folderRepo.find({
        where: { ownerId, parentId: folderId ?? IsNull(), isDeleted: false },
        order: { name: 'ASC' },
      }),
      this.fileRepo.find({
        where: fileWhere,
        order: { originalName: 'ASC' },
      }),
    ]);
    return { subfolders, files };
  }

  // ---------- 写操作 ----------

  async createFolder(ownerId: string, dto: CreateFolderDto): Promise<Folder> {
    // 保留 assertFolderOwned 返回的完整父实体，供下方 parent 关联使用；
    // 仅传 { id } 部分对象会让 TypeORM 闭包表插入时缺少必要的实体信息
    let parentFolder: Folder | null = null;
    if (dto.parentId) {
      parentFolder = await this.assertFolderOwned(dto.parentId, ownerId);
      // 嵌套深度上限校验，避免闭包表平方级膨胀与递归栈溢出
      const parentDepth = await this.getFolderDepth(dto.parentId);
      if (parentDepth + 1 > MAX_FOLDER_DEPTH) {
        throw new BadRequestException(`文件夹嵌套层级不能超过 ${MAX_FOLDER_DEPTH} 层`);
      }
    }
    const existing = await this.folderRepo.findOne({
      where: { ownerId, parentId: dto.parentId ?? IsNull(), name: dto.name, isDeleted: false },
    });
    if (existing) {
      throw new BadRequestException('同层级下已存在同名文件夹');
    }
    const folder = this.folderRepo.create({
      name: dto.name,
      ownerId,
      parentId: dto.parentId ?? null,
      parent: parentFolder,
    });
    const saved = await this.folderRepo.save(folder);
    this.audit.log({
      action: 'folder_create' as AuditAction,
      userId: ownerId,
      resourceType: 'folder',
      resourceId: saved.id,
      metadata: { name: dto.name, parentId: dto.parentId ?? null },
    });
    return saved;
  }

  async renameFolder(ownerId: string, id: string, dto: RenameFolderDto): Promise<Folder> {
    const folder = await this.assertFolderOwned(id, ownerId);
    const sibling = await this.folderRepo.findOne({
      where: {
        ownerId,
        parentId: folder.parentId ?? IsNull(),
        name: dto.name,
        isDeleted: false,
        id: Not(id),
      },
    });
    if (sibling) {
      throw new BadRequestException('同层级下已存在同名文件夹');
    }
    const oldName = folder.name;
    folder.name = dto.name;
    const saved = await this.folderRepo.save(folder);
    this.audit.log({
      action: 'folder_rename' as AuditAction,
      userId: ownerId,
      resourceType: 'folder',
      resourceId: id,
      metadata: { from: oldName, to: dto.name },
    });
    return saved;
  }

  async moveFolder(ownerId: string, id: string, dto: MoveFolderDto): Promise<Folder> {
    const folder = await this.assertFolderOwned(id, ownerId);
    const newParentId = dto.parentId ?? null;
    // 先记录原父级，避免修改 parentId 后审计 from/to 恒为新值
    const oldParentId = folder.parentId;

    if (newParentId === id) {
      throw new BadRequestException('不能把文件夹移入自身');
    }

    if (newParentId) {
      const newParent = await this.assertFolderOwned(newParentId, ownerId);
      // 循环检测：新父级不能是当前文件夹的后代
      if (await this.isDescendantOf(newParentId, id)) {
        throw new BadRequestException('不能把文件夹移入其自身子树');
      }
      // 嵌套深度上限校验：新父级深度 + 1 + 被移动子树高度 不得超过上限
      const newParentDepth = await this.getFolderDepth(newParentId);
      const subtreeHeight = await this.getSubtreeHeight(id);
      if (newParentDepth + 1 + subtreeHeight > MAX_FOLDER_DEPTH) {
        throw new BadRequestException(`移动后文件夹嵌套层级不能超过 ${MAX_FOLDER_DEPTH} 层`);
      }
      folder.parent = newParent;
      folder.parentId = newParentId;
    } else {
      folder.parent = null;
      folder.parentId = null;
    }

    // 同层级重名检查（排除自身）
    const sibling = await this.folderRepo.findOne({
      where: {
        ownerId,
        parentId: newParentId ?? IsNull(),
        name: folder.name,
        isDeleted: false,
        id: Not(id),
      },
    });
    if (sibling) {
      throw new BadRequestException('目标层级下已存在同名文件夹');
    }

    const saved = await this.folderRepo.save(folder);
    this.audit.log({
      action: 'folder_move' as AuditAction,
      userId: ownerId,
      resourceType: 'folder',
      resourceId: id,
      metadata: { from: oldParentId, to: newParentId },
    });
    return saved;
  }

  /**
   * 软删除文件夹：联动软删子树 + 内含文件。
   * 沿用 files 表的 7 天延迟机制。
   */
  async softDeleteFolder(ownerId: string, id: string, byAdmin = false): Promise<void> {
    const folder = await this.assertFolderOwned(id, ownerId);
    const now = new Date();
    const scheduledAt = new Date(now.getTime() + SOFT_DELETE_GRACE_DAYS * 24 * 3600 * 1000);

    // 拿到子树所有 folder id（包含自身）
    const descendants = await this.folderRepo.findDescendants(folder);
    const folderIds = descendants.map((f) => f.id).filter((fid) => fid !== id);
    folderIds.push(id);

    // 事务内原子执行：软删子文件夹 + 软删内含文件，避免中途失败导致部分删除不一致
    await this.folderRepo.manager.transaction(async (manager) => {
      await manager.update(
        Folder,
        { id: In(folderIds), isDeleted: false },
        { isDeleted: true, deleteRequestedAt: now, deleteScheduledAt: scheduledAt },
      );
      await manager.update(
        File,
        { folderId: In(folderIds), isDeleted: false },
        { isDeleted: true, deleteRequestedAt: now, deleteScheduledAt: scheduledAt, deletedByAdmin: byAdmin },
      );
    });

    await this.audit.logAwait({
      action: (byAdmin ? 'folder_delete_by_admin' : 'folder_delete') as AuditAction,
      userId: ownerId,
      resourceType: 'folder',
      resourceId: id,
      metadata: {
        name: folder.name,
        affectedFolders: folderIds.length,
        affectedFiles: await this.fileRepo.count({
          where: { folderId: In(folderIds), deleteRequestedAt: now },
        }),
        scheduledAt,
        byAdmin,
      },
    });
  }

  async restoreFolder(ownerId: string, id: string): Promise<void> {
    const folder = await this.folderRepo.findOne({
      where: { id, ownerId, isDeleted: true },
    });
    if (!folder) {
      throw new NotFoundException('文件夹不存在或未被删除');
    }
    // 还原子树中所有 folder——但只恢复与本文件夹同批删除的，
    // 避免恢复在文件夹删除之前已独立删除的子文件夹。
    const descendants = await this.folderRepo.findDescendants(folder);
    const folderIds = descendants.map((f) => f.id);

    // 以本批次的计划删除时间作为同批标记（softDeleteFolder 对整批写入同一 deleteScheduledAt），
    // 比精确 deleteRequestedAt 更稳定；deleteScheduledAt 为空时回退到 deleteRequestedAt。
    const batchScheduledAt = folder.deleteScheduledAt;
    const batchRequestedAt = folder.deleteRequestedAt;
    const batchCriteria: Record<string, unknown> = batchScheduledAt
      ? { deleteScheduledAt: batchScheduledAt }
      : { deleteRequestedAt: batchRequestedAt };

    // 事务内原子还原子文件夹与内含文件
    await this.folderRepo.manager.transaction(async (manager) => {
      await manager.update(
        Folder,
        { id: In(folderIds), ...batchCriteria } as any,
        { isDeleted: false, deleteRequestedAt: null, deleteScheduledAt: null },
      );
      await manager.update(
        File,
        { folderId: In(folderIds), ...batchCriteria } as any,
        { isDeleted: false, deleteRequestedAt: null, deleteScheduledAt: null, deletedByAdmin: false },
      );
    });

    this.audit.log({
      action: 'folder_restore' as AuditAction,
      userId: ownerId,
      resourceType: 'folder',
      resourceId: id,
    });
  }

  // ---------- 文件移动 ----------

  async moveFile(ownerId: string, fileId: string, dto: MoveFileDto): Promise<File> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, uploaderId: ownerId, isDeleted: false },
    });
    if (!file) {
      throw new NotFoundException('文件不存在');
    }
    if (dto.folderId) {
      await this.assertFolderOwned(dto.folderId, ownerId);
    }
    const oldFolderId = file.folderId;
    file.folderId = dto.folderId ?? null;
    const saved = await this.fileRepo.save(file);
    this.audit.log({
      action: 'file_move' as AuditAction,
      userId: ownerId,
      resourceType: 'file',
      resourceId: fileId,
      metadata: { from: oldFolderId, to: dto.folderId ?? null },
    });
    return saved;
  }

  // ---------- 文件重命名 ----------

  /**
   * 重命名文件显示名（originalName）。
   * 仅更新展示用名称，不改动底层存储的 filename / Telegram 引用。
   */
  async renameFile(ownerId: string, fileId: string, dto: RenameFileDto): Promise<File> {
    const file = await this.fileRepo.findOne({
      where: { id: fileId, uploaderId: ownerId, isDeleted: false },
    });
    if (!file) {
      throw new NotFoundException('文件不存在');
    }
    const oldName = file.originalName;
    file.originalName = dto.newOriginalName;
    const saved = await this.fileRepo.save(file);
    this.audit.log({
      action: 'file_rename' as AuditAction,
      userId: ownerId,
      resourceType: 'file',
      resourceId: fileId,
      metadata: { from: oldName, to: dto.newOriginalName },
    });
    return saved;
  }

  // ---------- 文件复制 ----------

  /**
   * 复制文件（生成独立副本）。
   *
   * 副本复用源文件的 Telegram 存储引用（telegramFileId / telegramFilePath /
   * thumbnailPath / mimeType / size / filename），不重新上传字节，属于轻量级
   * 引用复制。副本是独立的 File 记录，可单独重命名、移动、删除。
   * originalName 追加 " - 副本" 后缀；若已存在同名副本则累加计数。
   */
  async copyFile(ownerId: string, fileId: string, dto: CopyFileDto): Promise<File> {
    const source = await this.fileRepo.findOne({
      where: { id: fileId, uploaderId: ownerId, isDeleted: false },
    });
    if (!source) {
      throw new NotFoundException('文件不存在');
    }
    if (dto.folderId) {
      await this.assertFolderOwned(dto.folderId, ownerId);
    }

    const copy = this.fileRepo.create({
      filename: source.filename,
      originalName: await this.buildCopyName(source.originalName, ownerId, dto.folderId ?? null),
      mimeType: source.mimeType,
      size: source.size,
      telegramFileId: source.telegramFileId,
      telegramFilePath: source.telegramFilePath,
      thumbnailPath: source.thumbnailPath,
      folderId: dto.folderId ?? null,
      accessType: source.accessType,
      uploaderId: ownerId,
      status: 'ready',
    });
    const saved = await this.fileRepo.save(copy);
    this.audit.log({
      action: 'file_copy' as AuditAction,
      userId: ownerId,
      resourceType: 'file',
      resourceId: saved.id,
      metadata: { sourceId: fileId, to: dto.folderId ?? null },
    });
    return saved;
  }

  /**
   * 生成不与目标文件夹内现有文件重名的副本名称。
   * 形如 "photo.png - 副本"、"photo.png - 副本 2"……
   */
  private async buildCopyName(originalName: string, ownerId: string, folderId: string | null): Promise<string> {
    const base = `${originalName} - 副本`;
    let candidate = base;
    let counter = 1;
    // 逐个探测重名（副本操作低频，O(k) 查询可接受；k 为同名副本数量）
    for (;;) {
      const exists = await this.fileRepo.findOne({
        where: { uploaderId: ownerId, folderId: folderId ?? IsNull(), originalName: candidate, isDeleted: false },
        select: ['id'],
      });
      if (!exists) return candidate;
      counter += 1;
      candidate = `${base} ${counter}`;
    }
  }

  // ---------- 内部工具 ----------

  /**
   * 校验 folder 存在、未删除、且属于当前用户。
   * 返回 folder 实体供后续使用。
   */
  private async assertFolderOwned(folderId: string, ownerId: string): Promise<Folder> {
    const folder = await this.folderRepo.findOne({
      where: { id: folderId, ownerId, isDeleted: false },
    });
    if (!folder) {
      throw new NotFoundException('文件夹不存在或无权访问');
    }
    return folder;
  }

  /**
   * 判断 candidateId 是否是 ancestorId 的后代（用于循环检测）。
   * 使用 TypeORM findDescendantsTree 一次性拿到整棵子树。
   */
  private async isDescendantOf(candidateId: string, ancestorId: string): Promise<boolean> {
    const ancestor = await this.folderRepo.findOne({ where: { id: ancestorId } });
    if (!ancestor) return false;
    const tree = await this.folderRepo.findDescendantsTree(ancestor);
    return this.searchInTree(tree, candidateId);
  }

  private searchInTree(node: Folder, targetId: string): boolean {
    if (node.id === targetId) return true;
    return (node.children || []).some((c) => this.searchInTree(c, targetId));
  }

  /**
   * 返回文件夹深度（根目录直接子级为 0）。
   * 闭包表含自身行，故祖先数 = 深度 + 1。
   */
  private async getFolderDepth(folderId: string): Promise<number> {
    const rows = await this.folderRepo.manager.query(
      `SELECT COUNT(*)::int AS cnt FROM folder_closure WHERE id_descendant = $1`,
      [folderId],
    );
    return Math.max(0, (rows[0]?.cnt ?? 1) - 1);
  }

  /**
   * 返回以 folderId 为根的子树高度（自身为 0 层，叶子子树高度为 0）。
   * 统计子树内最深节点相对于根的层级，用于移动文件夹时校验移动后总深度。
   */
  private async getSubtreeHeight(folderId: string): Promise<number> {
    const rows = await this.folderRepo.manager.query(
      `SELECT COALESCE(MAX(cnt), 1)::int AS h FROM (
         SELECT COUNT(*) AS cnt FROM folder_closure fc1
         WHERE fc1.id_descendant IN (SELECT id_descendant FROM folder_closure WHERE id_ancestor = $1)
           AND fc1.id_ancestor IN (SELECT id_descendant FROM folder_closure WHERE id_ancestor = $1)
         GROUP BY fc1.id_descendant
       ) sub`,
      [folderId],
    );
    return Math.max(0, (rows[0]?.h ?? 1) - 1);
  }

  /**
   * 把扁平 folder 数组构建成树（内存 O(n)）。
   * TypeORM TreeRepository.findTrees 也支持，但它按 root 节点过滤，
   * 这里我们直接拿全部 folder 自己构建，避免多次查询。
   */
  private buildTreeFromFlat(folders: Folder[]): Folder[] {
    const map = new Map<string, Folder>();
    const roots: Folder[] = [];
    // 第一遍：clone 并清空 children，构建 id->node 映射
    for (const f of folders) {
      map.set(f.id, { ...f, children: [] });
    }
    // 第二遍：连接 parent->child
    for (const f of folders) {
      const node = map.get(f.id)!;
      if (f.parentId && map.has(f.parentId)) {
        map.get(f.parentId)!.children!.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }
}
