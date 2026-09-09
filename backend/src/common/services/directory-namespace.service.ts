import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { isDatabaseUniqueViolation } from '../../database/database-types';
import { DirectoryName, DirectoryNameEntityType } from '../entities/directory-name.entity';

/** 申请/释放目录名称所需的参数 */
export interface NamespaceAcquireParams {
  ownerId: string;
  /** 目标目录 ID；null/undefined 表示根目录 */
  folderId: string | null | undefined;
  /** 原始名称（服务内部做 NFC + 小写折叠） */
  name: string;
  entityType: DirectoryNameEntityType;
  entityId: string;
}

export interface NamespaceEntityRef {
  entityType: DirectoryNameEntityType;
  entityId: string;
}

/**
 * 统一目录命名空间服务（v1.2.6）。
 *
 * 目标：同一用户、同一目录下，文件与文件夹共享一个大小写不敏感的名称空间。
 * 冲突的最终裁决是 directory_names 上的部分唯一索引（并发下由数据库保证），
 * 服务层预检查只用于更友好的错误提示，不是安全边界。
 *
 * 所有方法都接受 EntityManager：调用方必须在自身事务内调用，保证
 * 「实体写入 + 名称占用」的原子性。冲突统一抛 ConflictException(409)。
 */
@Injectable()
export class DirectoryNamespaceService {
  /** 根目录范围键哨兵值（避免 NULL 参与唯一索引） */
  static readonly ROOT_SCOPE = '__root__';

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /** 名称规范化：Unicode NFC 归一化 + 小写折叠（大小写不敏感判定） */
  static nameKey(name: string): string {
    return name.normalize('NFC').toLowerCase();
  }

  /** 目录范围键：目录 ID 或根目录哨兵 */
  static scopeKey(folderId: string | null | undefined): string {
    return folderId || DirectoryNamespaceService.ROOT_SCOPE;
  }

  /** 事务外便捷入口：使用独立事务执行 acquire */
  async acquireStandalone(params: NamespaceAcquireParams): Promise<void> {
    await this.dataSource.transaction(async (manager) => this.acquire(manager, params));
  }

  /**
   * 在事务内为实体占用名称。
   * - 实体已有名称行（恢复/改名/换目录复用）→ 更新行并重新激活；
   * - 无名称行（新建/历史回填遗漏）→ 插入新行；
   * - 与其他活跃名称冲突（数据库唯一索引）→ ConflictException。
   */
  async acquire(manager: EntityManager, params: NamespaceAcquireParams): Promise<void> {
    const { ownerId, folderId, name, entityType, entityId } = params;
    const scopeKey = DirectoryNamespaceService.scopeKey(folderId);
    const nameKey = DirectoryNamespaceService.nameKey(name);
    const repo = manager.getRepository(DirectoryName);

    // 1. 已有本实体名称行 → 原位更新（改名/移动/恢复共用）
    // N5：改名/移动撞名时该 UPDATE 同样触发唯一约束——此前在 try 之外，
    // QueryFailedError 会以 500 逸出而不是 409。与 INSERT 分支统一转换。
    let updated: { affected?: number | null };
    try {
      updated = await repo
        .createQueryBuilder()
        .update(DirectoryName)
        .set({ ownerId, scopeKey, nameKey, isDeleted: false })
        .where('"entityType" = :entityType AND "entityId" = :entityId', { entityType, entityId })
        .execute();
    } catch (error: unknown) {
      if (isDatabaseUniqueViolation(error)) {
        throw new ConflictException('当前目录已存在同名文件或文件夹');
      }
      throw error;
    }
    if ((updated.affected ?? 0) > 0) return;

    // 2. 无名称行 → 插入（历史回填遗漏时补建）
    try {
      await repo.insert({ ownerId, scopeKey, nameKey, entityType, entityId, isDeleted: false });
    } catch (error: unknown) {
      if (isDatabaseUniqueViolation(error)) {
        throw new ConflictException('当前目录已存在同名文件或文件夹');
      }
      throw error;
    }
  }

  /** 事务外便捷入口：使用独立事务执行 release */
  async releaseStandalone(ref: NamespaceEntityRef): Promise<void> {
    await this.dataSource.transaction(async (manager) => this.release(manager, ref));
  }

  /** 实体进入回收站（软删除）时释放名称；幂等。 */
  async release(manager: EntityManager, ref: NamespaceEntityRef): Promise<void> {
    await manager
      .getRepository(DirectoryName)
      .createQueryBuilder()
      .update(DirectoryName)
      .set({ isDeleted: true })
      .where('"entityType" = :entityType AND "entityId" = :entityId AND "isDeleted" = false', {
        entityType: ref.entityType,
        entityId: ref.entityId,
      })
      .execute();
  }

  /** 批量释放名称（文件夹级联软删除子树场景）；幂等。 */
  async releaseMany(manager: EntityManager, refs: NamespaceEntityRef[]): Promise<void> {
    if (refs.length === 0) return;
    const entityTypeValues = [...new Set(refs.map((r) => r.entityType))];
    const entityIdValues = refs.map((r) => r.entityId);
    await manager
      .getRepository(DirectoryName)
      .createQueryBuilder()
      .update(DirectoryName)
      .set({ isDeleted: true })
      .where('"entityType" IN (:...entityTypeValues) AND "entityId" IN (:...entityIdValues) AND "isDeleted" = false', {
        entityTypeValues,
        entityIdValues,
      })
      .execute();
  }

  /** 实体物理删除时移除名称行；幂等。 */
  async remove(manager: EntityManager, ref: NamespaceEntityRef): Promise<void> {
    await manager
      .getRepository(DirectoryName)
      .delete({ entityType: ref.entityType, entityId: ref.entityId });
  }

  /**
   * 事务内批量恢复名称（回收站恢复场景）。
   * 与其他活跃名称冲突时数据库唯一索引报错 → 由调用方转为业务错误并回滚。
   */
  async reactivateMany(
    manager: EntityManager,
    refs: NamespaceEntityRef[],
  ): Promise<void> {
    if (refs.length === 0) return;
    const entityTypeValues = [...new Set(refs.map((r) => r.entityType))];
    const entityIdValues = refs.map((r) => r.entityId);
    await manager
      .getRepository(DirectoryName)
      .createQueryBuilder()
      .update(DirectoryName)
      .set({ isDeleted: false })
      .where('"entityType" IN (:...entityTypeValues) AND "entityId" IN (:...entityIdValues) AND "isDeleted" = true', {
        entityTypeValues,
        entityIdValues,
      })
      .execute();
  }

  /** 查询名称是否已被其他活跃实体占用（服务层友好预检查用，非安全边界） */
  async isNameTaken(
    ownerId: string,
    folderId: string | null | undefined,
    name: string,
    exclude?: NamespaceEntityRef,
  ): Promise<boolean> {
    const qb = this.dataSource
      .getRepository(DirectoryName)
      .createQueryBuilder('dn')
      .where('dn.ownerId = :ownerId', { ownerId })
      .andWhere('dn.scopeKey = :scopeKey', { scopeKey: DirectoryNamespaceService.scopeKey(folderId) })
      .andWhere('dn.nameKey = :nameKey', { nameKey: DirectoryNamespaceService.nameKey(name) })
      .andWhere('dn.isDeleted = false');
    if (exclude) {
      qb.andWhere('NOT (dn."entityType" = :exType AND dn."entityId" = :exId)', {
        exType: exclude.entityType,
        exId: exclude.entityId,
      });
    }
    const count = await qb.getCount();
    return count > 0;
  }
}
