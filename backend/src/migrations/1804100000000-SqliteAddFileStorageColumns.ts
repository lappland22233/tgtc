import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `files` 表新增存储后端判别三列（SQLite 方言）。
 *
 * 与 PG 侧同名迁移语义一致：`storageBackend` 默认 'telegram'（存量零迁移兼容），
 * `storageAccountId + storageObjectRef` 为非 TG 后端的权威引用。
 *
 * 全新库由 SQLite 基线按实体元数据建表；存量库基线已执行不会重跑，故此处用
 * `getTable` 判定后补齐（SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，
 * 与 180370 一致）；索引用 `CREATE INDEX IF NOT EXISTS` 幂等创建。
 *
 * 注意：本文件必须带 `-Sqlite` 后缀，否则不会被正式 SQLite 迁移 glob 加载。
 */
export class SqliteAddFileStorageColumns1804100000000 implements MigrationInterface {
  name = 'SqliteAddFileStorageColumns1804100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;

    const table = await queryRunner.getTable('files');
    if (!table) return;

    if (!table.columns.some((column) => column.name === 'storageBackend')) {
      await queryRunner.query(
        `ALTER TABLE "files" ADD COLUMN "storageBackend" varchar(16) NOT NULL DEFAULT 'telegram'`,
      );
    }
    if (!table.columns.some((column) => column.name === 'storageAccountId')) {
      await queryRunner.query(
        `ALTER TABLE "files" ADD COLUMN "storageAccountId" varchar(64)`,
      );
    }
    if (!table.columns.some((column) => column.name === 'storageObjectRef')) {
      await queryRunner.query(
        `ALTER TABLE "files" ADD COLUMN "storageObjectRef" varchar(1024)`,
      );
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_files_storage_ref"`
      + ` ON "files" ("storageAccountId", "storageObjectRef")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    // SQLite 旧版本不支持 DROP COLUMN；保留可空列无数据风险，与既有迁移（180370）保持一致。
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_storage_ref"`);
  }
}