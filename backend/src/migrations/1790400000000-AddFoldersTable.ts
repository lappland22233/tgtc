import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 1: 创建 folders 表（闭包表）+ folder_closure 关系表 + files.folderId 列。
 *
 * 注意：TypeORM 的 closure-table 自动管理 folder_closure 表结构，
 * 但迁移里需要显式建表，因为 synchronize=false（生产环境）。
 *
 * ShareLink 实体在 Phase 2 单独迁移。
 */
export class AddFoldersTable1790400000000 implements MigrationInterface {
  name = 'AddFoldersTable1790400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. folders 主表
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "folders" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"          varchar(255) NOT NULL,
        "ownerId"       uuid NOT NULL,
        "parentId"      uuid,
        "isDeleted"      boolean NOT NULL DEFAULT false,
        "deleteRequestedAt" timestamp,
        "deleteScheduledAt" timestamp,
        "createdAt"     TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"     TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "FK_folders_owner_users" FOREIGN KEY ("ownerId")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_folders_parent_folders" FOREIGN KEY ("parentId")
          REFERENCES "folders"("id") ON DELETE CASCADE
      )
    `);

    // 2. 索引：所有者+父级下的文件夹查询（左侧树展开、列出子级）
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_folders_owner_parent"
        ON "folders" ("ownerId", "parentId")
        WHERE "isDeleted" = false
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_folders_parentId" ON "folders" ("parentId")`);

    // 3. 闭包表（TypeORM @Tree('closure-table') 自动使用）
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

    // 4. files 表加 folderId 列 + 外键 + 索引
    await queryRunner.query(`
      ALTER TABLE "files"
        ADD COLUMN IF NOT EXISTS "folderId" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "files"
        ADD CONSTRAINT "FK_files_folder_folders"
        FOREIGN KEY ("folderId") REFERENCES "folders"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_files_owner_folder"
        ON "files" ("uploaderId", "folderId")
        WHERE "isDeleted" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_files_owner_folder"`);
    await queryRunner.query(`ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "FK_files_folder_folders"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "folderId"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_closure_descendant"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "folder_closure"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_folders_parentId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_folders_owner_parent"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "folders"`);
  }
}
