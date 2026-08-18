import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
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

/** Windows 保留设备名：不区分大小写、忽略扩展名（如 con.txt 也命中） */
const RESERVED_DEVICE_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

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

  /**
   * 返回从根到当前文件夹的路径（面包屑）。
   *
   * 沿 parentId 链逐级上溯实现，不依赖闭包表行：历史上闭包联结表名曾配置错误
   * （实体默认解析为 folders_closure，而迁移建的是 folder_closure），存量文件夹
   * 的闭包行可能缺失或从未写入，若此处用 findAncestors（闭包表查询）会导致
   * 面包屑返回空甚至 SQL 报错，进而阻断前端文件夹导航。
   * folders."parentId" 有索引且深度 ≤ MAX_FOLDER_DEPTH，O(depth) 单行查询可接受。
   */
  async getBreadcrumb(ownerId: string, folderId: string | null): Promise<Folder[]> {
    if (!folderId) return [];
    const path: Folder[] = [];
    let current: Folder | null = await this.assertFolderOwned(folderId, ownerId);
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.id)) break; // 脏数据防御：parentId 成环时终止
      seen.add(current.id);
      path.push(current);
      if (!current.parentId) break;
      current = await this.folderRepo.findOne({ where: { id: current.parentId } });
      // 祖先必须属于同一用户（跨用户数据视为断链）
      if (current && current.ownerId !== ownerId) break;
    }
    // path 收集顺序为自身→根，反转为根→自身；与旧实现一致过滤已删除节点
    return path.reverse().filter((f) => !f.isDeleted);
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
    // 特殊保留名称拦截（'.'/'..'/Windows 设备名），在任何持久化操作之前执行
    this.assertFolderNameAllowed(dto.name);
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
    let saved: Folder;
    try {
      saved = await this.folderRepo.save(folder);
    } catch (error: unknown) {
      // G6-06：并发下同层重名可能绕过服务层 pre-check，被部分唯一索引（23505）兜底拦截，
      // 统一转为 409 冲突，与 pre-check 的语义一致。
      this.throwConflictIfUniqueViolation(error, '同层级下已存在同名文件夹');
      throw error;
    }
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
    // 特殊保留名称拦截，与 createFolder 规则一致
    this.assertFolderNameAllowed(dto.name);
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
    let saved: Folder;
    try {
      saved = await this.folderRepo.save(folder);
    } catch (error: unknown) {
      // G6-06：并发重命名撞同名，由唯一索引兜底转 409
      this.throwConflictIfUniqueViolation(error, '同层级下已存在同名文件夹');
      throw error;
    }
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
    const newParentId = dto.parentId ?? null;

    // 事务内完成「校验 + 保存」，避免 check-then-act 竞态：
    // 先对被移动节点 SELECT ... FOR UPDATE 加行锁，串行化并发移动，
    // 防止两个并发 move 交换父子关系后形成 parentId 互指环。
    const { saved, oldParentId } = await this.folderRepo.manager.transaction(async (manager) => {
      // 1. 锁定被移动节点（含软删/越权过滤），FOR UPDATE 保证本事务内视图一致
      const lockedRows = await manager.query(
        `SELECT * FROM folders WHERE id = $1 AND "ownerId" = $2 AND "isDeleted" = false FOR UPDATE`,
        [id, ownerId],
      );
      if (lockedRows.length === 0) {
        throw new NotFoundException('文件夹不存在或无权访问');
      }
      const locked: Folder = lockedRows[0];
      // 先记录原父级，避免修改 parentId 后审计 from/to 恒为新值
      const oldParentId = locked.parentId;

      if (newParentId === id) {
        throw new BadRequestException('不能把文件夹移入自身');
      }

      let newParentIdFinal: string | null = null;
      if (newParentId) {
        // 2. 校验并锁定新父级（存在/未删/归属）
        const parentRows = await manager.query(
          `SELECT * FROM folders WHERE id = $1 AND "ownerId" = $2 AND "isDeleted" = false FOR UPDATE`,
          [newParentId, ownerId],
        );
        if (parentRows.length === 0) {
          throw new NotFoundException('文件夹不存在或无权访问');
        }
        // 3. 循环检测：新父级不能是当前文件夹的后代（沿 parentId 上溯，不依赖闭包表）
        if (await this.isDescendantOfInManager(manager, newParentId, id)) {
          throw new BadRequestException('不能把文件夹移入其自身子树');
        }
        // 4. 嵌套深度上限校验：新父级深度 + 1 + 被移动子树高度 不得超过上限
        const newParentDepth = await this.getFolderDepthInManager(manager, newParentId);
        const subtreeHeight = await this.getSubtreeHeightInManager(manager, id);
        if (newParentDepth + 1 + subtreeHeight > MAX_FOLDER_DEPTH) {
          throw new BadRequestException(`移动后文件夹嵌套层级不能超过 ${MAX_FOLDER_DEPTH} 层`);
        }
        newParentIdFinal = newParentId;
      }

      // 5. 同层级重名检查（排除自身）
      const sibling = await manager.getRepository(Folder).findOne({
        where: {
          ownerId,
          parentId: newParentIdFinal ?? IsNull(),
          name: locked.name,
          isDeleted: false,
          id: Not(id),
        },
      });
      if (sibling) {
        throw new BadRequestException('目标层级下已存在同名文件夹');
      }

      // 6. 更新 parentId（走 SQL，保证闭包表与父链一致由 TypeORM save 语义处理）
      const repo = manager.getRepository(Folder);
      locked.parentId = newParentIdFinal;
      if (newParentIdFinal) {
        locked.parent = { id: newParentIdFinal } as Folder;
      } else {
        locked.parent = null;
      }
      let saved: Folder;
      try {
        saved = await repo.save(locked);
      } catch (error: unknown) {
        // G6-06：并发移动撞同名，由唯一索引兜底转 409
        this.throwConflictIfUniqueViolation(error, '目标层级下已存在同名文件夹');
        throw error;
      }
      return { saved, oldParentId };
    });

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

    // 拿到子树所有 folder id（含自身），沿 parentId 递归 CTE，不依赖闭包表
    const folderIds = await this.collectSubtreeIds(id);

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

    // G6-05：恢复前校验祖先链。若存在被删（软删）的祖先，直接恢复会形成
    // 「父级仍被删、子级已恢复」的幻影根，破坏树结构一致性。此时拒绝恢复，
    // 提示先恢复顶层祖先；由上层递归逐级恢复保证整条链完整。
    let ancestor = folder.parentId ? await this.folderRepo.findOne({ where: { id: folder.parentId } }) : null;
    while (ancestor) {
      if (ancestor.isDeleted) {
        throw new BadRequestException('该文件夹的上级目录仍处于回收站中，请先恢复上级目录');
      }
      if (!ancestor.parentId) break;
      ancestor = await this.folderRepo.findOne({ where: { id: ancestor.parentId } });
    }

    // 还原子树中所有 folder——但只恢复与本文件夹同批删除的，
    // 避免恢复在文件夹删除之前已独立删除的子文件夹。
    // 沿 parentId 递归 CTE 收集子树，不依赖闭包表。
    const folderIds = await this.collectSubtreeIds(id);

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
    // G6-07：只允许复制 status === 'ready' 的文件。
    // processing/error 文件的 telegramFileId 尚未就绪或已失效，副本会指向无效引用，
    // 复制后无法下载。统一在复制前校验，未就绪文件抛 409。
    if (source.status !== 'ready') {
      throw new ConflictException('仅就绪状态的文件可以复制，请等待处理完成或稍后重试');
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
      // G2-18：副本完整继承源文件的保护条件（密码/访问次数/有效期），
      // 避免副本"只继承 accessType 不继承约束"而裸奔（保护条件被绕过）。
      password: source.password,
      maxAccessCount: source.maxAccessCount,
      expiresIn: source.expiresIn,
      expiresStartAt: source.expiresStartAt,
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
   * 拒绝特殊保留名称：
   * - '.' / '..' 一律拒绝（防路径穿越，用户明确要求）；
   * - Windows 保留设备名 CON/PRN/AUX/NUL/COM1-9/LPT1-9（不区分大小写、忽略扩展名，
   *   如 con.txt 也拒绝），避免下载/打包时在 Windows 上产生不可用文件。
   * 字符集层面的非法字符由 DTO 层 @Matches 拦截（服务层内调兼容绕过管道的使用方）。
   */
  private assertFolderNameAllowed(name: string): void {
    if (name === '.' || name === '..' || RESERVED_DEVICE_NAME_PATTERN.test(name)) {
      throw new BadRequestException('文件夹名称不允许使用保留名称');
    }
  }

  /**
   * G6-06：将"同层重名"数据库唯一约束冲突（PostgreSQL 错误码 23505）
   * 转换为 409 ConflictException，与服务层 pre-check 的语义保持一致。
   * 该索引是并发场景下的最终防线：pre-check 通过后并发写入可能同时成功，
   * 由数据库兜底拦截后在此统一转为业务可读的冲突错误。
   */
  private throwConflictIfUniqueViolation(error: unknown, message: string): void {
    if (
      error &&
      typeof error === 'object' &&
      (error as { code?: string }).code === '23505'
    ) {
      throw new ConflictException(message);
    }
  }

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
   * 收集以 rootId 为根的整棵子树 id（含自身），沿 parentId 递归 CTE 实现，
   * 不依赖闭包表（folder_closure 行可能缺失，历史配置错误）。
   * 结果含自身，供级联软删 / 恢复复用。
   */
  private async collectSubtreeIds(rootId: string): Promise<string[]> {
    const rows = await this.folderRepo.manager.query(
      `WITH RECURSIVE subtree AS (
         SELECT id FROM folders WHERE id = $1
         UNION ALL
         SELECT f.id FROM folders f
         JOIN subtree s ON f."parentId" = s.id
       )
       SELECT id FROM subtree`,
      [rootId],
    );
    return rows.map((r: { id: string }) => r.id);
  }

  /**
   * 事务内版本：判断 candidateId 是否是 ancestorId 的后代（沿 parentId 上溯）。
   * 在 moveFolder 事务内使用，复用事务连接以保证与 FOR UPDATE 锁一致性视图。
   */
  private async isDescendantOfInManager(
    manager: import('typeorm').EntityManager,
    candidateId: string,
    ancestorId: string,
  ): Promise<boolean> {
    const seen = new Set<string>();
    let currentId: string | null = candidateId;
    while (currentId) {
      if (currentId === ancestorId) return true;
      if (seen.has(currentId)) return false;
      seen.add(currentId);
      const rows: Array<{ parentId: string | null }> = await manager.query(
        `SELECT "parentId" FROM folders WHERE id = $1`,
        [currentId],
      );
      currentId = rows[0]?.parentId ?? null;
    }
    return false;
  }

  /**
   * 事务内版本：返回文件夹深度（根目录直接子级为 0）。
   * 沿 parentId 上溯计步，不依赖闭包表；与下载路径语义一致。
   */
  private async getFolderDepthInManager(
    manager: import('typeorm').EntityManager,
    folderId: string,
  ): Promise<number> {
    const seen = new Set<string>();
    let depth = 0;
    let currentId: string | null = folderId;
    while (currentId) {
      if (seen.has(currentId)) return depth; // 成环防御
      seen.add(currentId);
      const rows: Array<{ parentId: string | null }> = await manager.query(
        `SELECT "parentId" FROM folders WHERE id = $1`,
        [currentId],
      );
      const parentId = rows[0]?.parentId ?? null;
      if (!parentId) break;
      depth += 1;
      currentId = parentId;
    }
    return depth;
  }

  /**
   * 事务内版本：返回以 folderId 为根的子树高度（自身为 0 层）。
   * 沿 parentId 向下递归 CTE 计算最大深度，不依赖闭包表。
   */
  private async getSubtreeHeightInManager(
    manager: import('typeorm').EntityManager,
    folderId: string,
  ): Promise<number> {
    const rows: Array<{ h: number }> = await manager.query(
      `WITH RECURSIVE subtree AS (
         SELECT id, 0 AS depth FROM folders WHERE id = $1
         UNION ALL
         SELECT f.id, s.depth + 1 FROM folders f
         JOIN subtree s ON f."parentId" = s.id
       )
       SELECT COALESCE(MAX(depth), 0)::int AS h FROM subtree`,
      [folderId],
    );
    return rows[0]?.h ?? 0;
  }

  /**
   * 返回文件夹深度（根目录直接子级为 0）。
   * G6-08：改为沿 parentId 链上溯计步，不再依赖闭包表（folder_closure 行可能缺失，
   * 历史配置错误导致闭包行缺失时深度被错误地归零，绕过 MAX_FOLDER_DEPTH）。
   * 表名从实体元数据获取，避免硬编码。与 getFolderDepthInManager 语义一致。
   */
  private async getFolderDepth(folderId: string): Promise<number> {
    // 表名优先从实体元数据取（G6-08）；极端情况下（元数据未就绪）回退 'folders'，
    // 避免硬编码造成表名不一致的同时保持对单元测试 mock 的健壮性。
    const tableName = this.folderRepo.metadata?.tableName ?? 'folders';
    const seen = new Set<string>();
    let depth = 0;
    let currentId: string | null = folderId;
    while (currentId) {
      if (seen.has(currentId)) break; // 成环防御
      seen.add(currentId);
      const rows: Array<{ parentId: string | null }> = await this.folderRepo.manager.query(
        `SELECT "parentId" FROM ${tableName} WHERE id = $1`,
        [currentId],
      );
      const parentId = rows[0]?.parentId ?? null;
      if (!parentId) break;
      depth += 1;
      currentId = parentId;
    }
    return depth;
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
