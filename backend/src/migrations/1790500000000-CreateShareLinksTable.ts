import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2: 创建 share_links 表 + 数据迁移。
 *
 * 数据迁移：把现有 files.accessType='public' 的文件复制成 ShareLink 记录，
 * token 用文件原 id（确保老链接 /files/public/{id} 302 重定向到 /s/{id} 仍可命中）。
 *
 * 文件夹分享在 Phase 3 实现，本迁移只处理 file 类型。
 */
export class CreateShareLinksTable1790500000000 implements MigrationInterface {
  name = 'CreateShareLinksTable1790500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 创建 share_links 表
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "share_links" (
        "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "token"               varchar(64) NOT NULL,
        "targetType"          varchar(10) NOT NULL,
        "targetId"            uuid NOT NULL,
        "creatorId"           uuid NOT NULL,
        "password"            varchar,
        "maxAccessCount"      integer NOT NULL DEFAULT -1,
        "currentAccessCount"  integer NOT NULL DEFAULT 0,
        "expiresIn"           integer,
        "expiresStartAt"      timestamp,
        "status"              varchar(20) NOT NULL DEFAULT 'active',
        "isDeleted"           boolean NOT NULL DEFAULT false,
        "createdAt"           TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"           TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "FK_share_links_creator_users"
          FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    // 2. 唯一索引：token 全局唯一
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_share_links_token_unique"
      ON "share_links" ("token")
    `);

    // 3. 复合索引：按 target 查询（列出某文件的所有分享链接用）
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_share_links_target"
      ON "share_links" ("targetType", "targetId")
      WHERE "isDeleted" = false
    `);

    // 4. 索引：按创建者查询（我的分享列表用）
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_share_links_creator"
      ON "share_links" ("creatorId", "createdAt" DESC)
      WHERE "isDeleted" = false
    `);

    // 5. CHECK 约束：targetType 只能是 'file' 或 'folder'
    await queryRunner.query(`
      ALTER TABLE "share_links"
      ADD CONSTRAINT "CK_share_links_targetType"
      CHECK ("targetType" IN ('file', 'folder'))
    `);

    // 6. CHECK 约束：status 只能是 active/disabled/expired/exhausted
    await queryRunner.query(`
      ALTER TABLE "share_links"
      ADD CONSTRAINT "CK_share_links_status"
      CHECK ("status" IN ('active', 'disabled', 'expired', 'exhausted'))
    `);

    // 7. 数据迁移：现有 public 文件复制为 ShareLink（token=原 file.id）
    // 用 ON CONFLICT (token) DO NOTHING 防止重复执行（幂等）
    await queryRunner.query(`
      INSERT INTO "share_links" ("id", "token", "targetType", "targetId", "creatorId",
                                  "password", "maxAccessCount", "expiresIn", "expiresStartAt",
                                  "status", "isDeleted", "createdAt", "updatedAt")
      SELECT
        gen_random_uuid(),
        f."id",                          -- token 用文件 id（兼容老链接 302 重定向）
        'file',
        f."id",
        f."uploaderId",
        f."password",
        COALESCE(f."maxAccessCount", -1),
        f."expiresIn",
        f."expiresStartAt",
        CASE WHEN f."isDeleted" THEN 'disabled' ELSE 'active' END,
        false,
        COALESCE(f."createdAt", now()),
        now()
      FROM "files" f
      WHERE f."accessType" = 'public'
      ON CONFLICT ("token") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_share_links_creator"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_share_links_target"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_share_links_token_unique"`);
    await queryRunner.query(`ALTER TABLE "share_links" DROP CONSTRAINT IF EXISTS "CK_share_links_status"`);
    await queryRunner.query(`ALTER TABLE "share_links" DROP CONSTRAINT IF EXISTS "CK_share_links_targetType"`);
    await queryRunner.query(`ALTER TABLE "share_links" DROP CONSTRAINT IF EXISTS "FK_share_links_creator_users"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "share_links"`);
  }
}
