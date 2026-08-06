import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 回填 folder_closure 闭包表数据。
 *
 * 背景：Folder 实体早期使用 @Tree('closure-table') 默认联结表名（解析为
 * folders_closure），与迁移 1790400000000-AddFoldersTable 实际创建的
 * folder_closure 不一致，导致：
 * 1. 存量文件夹创建时闭包行写入了错误（或不存在）的表，folder_closure 中缺失历史行；
 * 2. 依赖闭包表的操作（软删子树 findDescendants、移动循环检测、深度校验）
 *    对存量数据返回不完整结果，存在数据完整性风险。
 *
 * 本迁移从 folders."parentId" 权威链出发，递归重建全部 (ancestor, descendant)
 * 闭包对（含自身行），幂等可重复执行（ON CONFLICT DO NOTHING）。
 * 若 folder_closure 表尚不存在（迁移从未执行过的环境），先按原始结构补建。
 */
export class BackfillFolderClosure1791000000000 implements MigrationInterface {
  name = 'BackfillFolderClosure1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 确保闭包表存在（与 1790400000000-AddFoldersTable 定义一致）
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "folder_closure" (
        "id_ancestor"   uuid NOT NULL,
        "id_descendant" uuid NOT NULL,
        PRIMARY KEY ("id_ancestor", "id_descendant"),
        CONSTRAINT "FK_closure_ancestor" FOREIGN KEY ("id_ancestor")
          REFERENCES "folders"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_closure_descendant" FOREIGN KEY ("id_descendant")
          REFERENCES "folders"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_closure_descendant" ON "folder_closure" ("id_descendant")`);

    // 2. 递归回填：每个节点先产生自身行 (id, id)，再沿 parentId 向后代扩展，
    //    生成全部 (祖先, 后代) 对。depth 上限 25（业务上限 20 层 + 余量）防御
    //    脏数据成环导致无限递归；DISTINCT + ON CONFLICT 保证幂等。
    await queryRunner.query(`
      INSERT INTO "folder_closure" ("id_ancestor", "id_descendant")
      WITH RECURSIVE pairs AS (
        SELECT id AS id_ancestor, id AS id_descendant, 0 AS depth FROM folders
        UNION ALL
        SELECT p.id_ancestor, f.id, p.depth + 1
        FROM folders f
        JOIN pairs p ON f."parentId" = p.id_descendant
        WHERE p.depth < 25
      )
      SELECT DISTINCT id_ancestor, id_descendant FROM pairs
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(): Promise<void> {
    // 数据回填不可精确撤销（无法区分回填行与正常写入行），
    // 且删除闭包行会重新引入本迁移要修复的问题，故 down 为空操作。
  }
}
