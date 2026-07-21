import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, TreeRepository, Not, IsNull, In } from 'typeorm';
import { Folder } from '../common/entities/folder.entity';
import { File } from '../common/entities/file.entity';
import { AuditService } from '../common/services/audit.service';
import { AuditAction } from '../common/entities/audit-log.entity';
import { CreateFolderDto, RenameFolderDto, MoveFolderDto, MoveFileDto } from './folder.dto';

const SOFT_DELETE_GRACE_DAYS = 7;

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
    if (dto.parentId) {
      await this.assertFolderOwned(dto.parentId, ownerId);
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
      parent: dto.parentId ? ({ id: dto.parentId } as Folder) : null,
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

    if (newParentId === id) {
      throw new BadRequestException('不能把文件夹移入自身');
    }

    if (newParentId) {
      const newParent = await this.assertFolderOwned(newParentId, ownerId);
      // 循环检测：新父级不能是当前文件夹的后代
      if (await this.isDescendantOf(newParentId, id)) {
        throw new BadRequestException('不能把文件夹移入其自身子树');
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

    const oldParentId = folder.parentId;
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

    // 软删所有子文件夹
    await this.folderRepo.update(
      { id: In(folderIds), isDeleted: false },
      { isDeleted: true, deleteRequestedAt: now, deleteScheduledAt: scheduledAt },
    );
    // 软删所有内含文件（保持 isDeleted + deleteRequestedAt + deleteScheduledAt 一致）
    await this.fileRepo.update(
      { folderId: In(folderIds), isDeleted: false },
      { isDeleted: true, deleteRequestedAt: now, deleteScheduledAt: scheduledAt, deletedByAdmin: byAdmin },
    );

    this.audit.log({
      action: (byAdmin ? 'folder_delete_by_admin' : 'folder_delete') as AuditAction,
      userId: ownerId,
      resourceType: 'folder',
      resourceId: id,
      metadata: { name: folder.name, affectedFolders: folderIds.length, scheduledAt },
    });
  }

  async restoreFolder(ownerId: string, id: string): Promise<void> {
    const folder = await this.folderRepo.findOne({
      where: { id, ownerId, isDeleted: true },
    });
    if (!folder) {
      throw new NotFoundException('文件夹不存在或未被删除');
    }
    // 还原子树所有 folder
    const descendants = await this.folderRepo.findDescendants(folder);
    const folderIds = descendants.map((f) => f.id);
    await this.folderRepo.update(
      { id: In(folderIds) },
      { isDeleted: false, deleteRequestedAt: null, deleteScheduledAt: null },
    );
    // 还原内含文件
    await this.fileRepo.update(
      { folderId: In(folderIds) },
      { isDeleted: false, deleteRequestedAt: null, deleteScheduledAt: null, deletedByAdmin: false },
    );
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
      where: { id: fileId, uploaderId: ownerId },
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
