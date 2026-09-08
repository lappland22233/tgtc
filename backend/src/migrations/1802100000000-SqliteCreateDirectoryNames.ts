import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * v1.2.6：统一目录命名空间（SQLite 方言）。
 * 表结构由 SQLite 基线迁移按实体元数据创建（DirectoryName 已注册实体清单），
 * 本迁移仅负责补充索引（幂等，IF NOT EXISTS）与历史数据回填。
 * 回填策略与 PostgreSQL 版一致：保留最早记录，冲突跳过。
 */
export class SqliteCreateDirectoryNames1802100000000 implements MigrationInterface {
  name = 'SqliteCreateDirectoryNames1802100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_directory_names_active"
      ON "directory_names" ("ownerId", "scopeKey", "nameKey")
      WHERE "isDeleted" = 0
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_directory_names_entity"
      ON "directory_names" ("entityType", "entityId")
    `);

    // 回填文件夹（活跃）：id 由随机 blob 生成 UUID v4 形态
    await queryRunner.query(`
      INSERT OR IGNORE INTO "directory_names"
        ("id", "ownerId", "scopeKey", "nameKey", "entityType", "entityId", "isDeleted", "createdAt", "updatedAt")
      SELECT
        lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
              substr(hex(randomblob(2)), 2) || '-' ||
              substr('89ab', abs(random()) % 4 + 1, 1) ||
              substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
        fo."ownerId",
        COALESCE(fo."parentId", '__root__'),
        lower(fo."name"),
        'folder',
        fo."id",
        0,
        COALESCE(fo."createdAt", datetime('now')),
        datetime('now')
      FROM "folders" fo
      WHERE fo."isDeleted" = 0
      ORDER BY fo."createdAt" ASC, fo."id" ASC
    `);

    // 回填文件（活跃）
    await queryRunner.query(`
      INSERT OR IGNORE INTO "directory_names"
        ("id", "ownerId", "scopeKey", "nameKey", "entityType", "entityId", "isDeleted", "createdAt", "updatedAt")
      SELECT
        lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
              substr(hex(randomblob(2)), 2) || '-' ||
              substr('89ab', abs(random()) % 4 + 1, 1) ||
              substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
        fi."uploaderId",
        COALESCE(fi."folderId", '__root__'),
        lower(fi."originalName"),
        'file',
        fi."id",
        0,
        COALESCE(fi."createdAt", datetime('now')),
        datetime('now')
      FROM "files" fi
      WHERE fi."isDeleted" = 0
      ORDER BY fi."createdAt" ASC, fi."id" ASC
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_directory_names_entity"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_directory_names_active"`);
    await queryRunner.query(`DELETE FROM "directory_names"`);
  }
}
