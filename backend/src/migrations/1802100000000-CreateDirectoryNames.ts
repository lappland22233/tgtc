import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * v1.2.6：统一目录命名空间表 + 历史数据回填（PostgreSQL）。
 *
 * 目标：同一用户、同一目录下文件与文件夹共享大小写不敏感的名称空间。
 * - nameKey = 名称 NFC + 小写折叠（回填用 SQL lower() 近似，应用层为 JS 规范化，
 *   对 ASCII/中文语义一致）；
 * - scopeKey = 目录 ID，根目录用 '__root__' 哨兵；
 * - 部分唯一索引仅约束活跃（isDeleted=false）名称。
 *
 * 回填策略（确定性、幂等）：按 createdAt, id 升序插入活跃实体名称，
 * 冲突（历史已存在的大小写变体重名/文件-文件夹跨表重名）时保留最早记录，
 * 后到者跳过（不生成名称行，应用层 acquire 会按需补建并做冲突校验）。
 */
export class CreateDirectoryNames1802100000000 implements MigrationInterface {
  name = 'CreateDirectoryNames1802100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "directory_names" (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "ownerId"    uuid NOT NULL,
        "scopeKey"   varchar(64) NOT NULL,
        "nameKey"    varchar(255) NOT NULL,
        "entityType" varchar(10) NOT NULL,
        "entityId"   uuid NOT NULL,
        "isDeleted"  boolean NOT NULL DEFAULT false,
        "createdAt"  TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"  TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_directory_names_active"
      ON "directory_names" ("ownerId", "scopeKey", "nameKey")
      WHERE "isDeleted" = false
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_directory_names_entity"
      ON "directory_names" ("entityType", "entityId")
    `);

    // 回填文件夹（活跃）
    await queryRunner.query(`
      INSERT INTO "directory_names" ("ownerId", "scopeKey", "nameKey", "entityType", "entityId", "isDeleted")
      SELECT fo."ownerId",
             COALESCE(fo."parentId"::text, '__root__'),
             lower(fo."name"),
             'folder',
             fo."id",
             false
      FROM "folders" fo
      WHERE fo."isDeleted" = false
      ORDER BY fo."createdAt" ASC, fo."id" ASC
      ON CONFLICT DO NOTHING
    `);

    // 回填文件（活跃）
    await queryRunner.query(`
      INSERT INTO "directory_names" ("ownerId", "scopeKey", "nameKey", "entityType", "entityId", "isDeleted")
      SELECT fi."uploaderId",
             COALESCE(fi."folderId"::text, '__root__'),
             lower(fi."originalName"),
             'file',
             fi."id",
             false
      FROM "files" fi
      WHERE fi."isDeleted" = false
      ORDER BY fi."createdAt" ASC, fi."id" ASC
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_directory_names_entity"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_directory_names_active"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "directory_names"`);
  }
}
