import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G6-06 / G6-13：folders 同层重名部分唯一约束。
 *
 * 背景：
 * - `folder.service.ts` 的创建/重命名/移动仅靠服务层 check-then-act 检查同层重名，
 *   并发场景存在竞态：两个请求同时创建同名文件夹都会通过 pre-check 后写入。
 * - 本迁移增加部分唯一索引 `UNIQUE(ownerId, parentId, name) WHERE isDeleted = false`，
 *   由数据库层保证"同一父级下、未删除的同名文件夹"唯一，作为最终防线。
 * - 实体 `folder.entity.ts` 同步声明该唯一约束（标注 partial），与迁移对齐。
 *
 * 风险点：
 * - 若存量库已存在同层重名数据（此前无约束，可能已被服务层 check 拦截、或历史脏数据），
 *   直接建索引会失败。因此 up 阶段先探测重复行：
 *   - 探测到重复 → 建索引会失败，先记录到 `_g606_folder_dups` 临时表，
 *     并抛错中止迁移（避免静默丢数据），由人工处理重复行后重跑。
 *   - 无重复 → 正常建索引。
 * - `parentId` 为 NULL 表示网盘根目录，PostgreSQL 唯一索引对 NULL 不生效
 *   （NULL != NULL），故根目录下的重名无法被该索引约束。服务层 pre-check 仍覆盖
 *   根目录场景（`parentId ?? IsNull()`），此处为 DB 层兜底。
 */
export class AddFolderSameLevelUniqueIndex1798100000001 implements MigrationInterface {
  name = 'AddFolderSameLevelUniqueIndex1798100000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 探测存量同层重名（未删除、同一 owner + parent + name）。
    //    排除 parentId IS NULL（网盘根目录）：PostgreSQL GROUP BY 会把所有 NULL 归为同一组，
    //    且该部分唯一索引对 NULL 本就不生效，否则根目录存在多个同名文件夹会被误判为重复而中止迁移。
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS _g606_folder_dups AS
       SELECT "ownerId", "parentId", name, COUNT(*) AS cnt
       FROM "folders"
       WHERE "isDeleted" = false AND "parentId" IS NOT NULL
       GROUP BY "ownerId", "parentId", name
       HAVING COUNT(*) > 1`,
    );
    const dups = await queryRunner.query(`SELECT COUNT(*)::int AS n FROM _g606_folder_dups`);
    if ((dups?.[0]?.n ?? 0) > 0) {
      // 存在重复，中止迁移（避免建索引失败或被静默处理），提示人工清理
      throw new Error(
        `检测到 ${dups[0].n} 组同层重名文件夹（已记录于 _g606_folder_dups），` +
          `请人工清理后重跑迁移；临时表 _g606_folder_dups 保留供排查`,
      );
    }

    // 2. 无重复 → 创建部分唯一索引（幂等）
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_folders_owner_parent_name_active"
       ON "folders" ("ownerId", "parentId", "name")
       WHERE "isDeleted" = false`,
    );

    // 清理临时探测表
    await queryRunner.query(`DROP TABLE IF EXISTS _g606_folder_dups`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_folders_owner_parent_name_active"`);
  }
}
