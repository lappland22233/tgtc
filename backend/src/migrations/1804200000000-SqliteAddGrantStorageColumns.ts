import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `telegram_bot_file_grants` 表新增存储后端判别与清理跟踪四列（SQLite 方言）。
 *
 * 与 PG 侧迁移对应：`storageBackend` 默认 'telegram'，存量行向后兼容。
 * SQLite 使用 `getTable` 判定后动态补齐缺失列。
 */
export class SqliteAddGrantStorageColumns1804200000000 implements MigrationInterface {
  name = 'SqliteAddGrantStorageColumns1804200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'better-sqlite3') return;

    const table = await queryRunner.getTable('telegram_bot_file_grants');
    if (!table) return;

    if (!table.columns.some((column) => column.name === 'storageBackend')) {
      await queryRunner.query(
        `ALTER TABLE "telegram_bot_file_grants" ADD COLUMN "storageBackend" varchar(16) NOT NULL DEFAULT 'telegram'`,
      );
    }
    if (!table.columns.some((column) => column.name === 'storageAccountId')) {
      await queryRunner.query(
        `ALTER TABLE "telegram_bot_file_grants" ADD COLUMN "storageAccountId" varchar(64)`,
      );
    }
    if (!table.columns.some((column) => column.name === 'storageObjectRef')) {
      await queryRunner.query(
        `ALTER TABLE "telegram_bot_file_grants" ADD COLUMN "storageObjectRef" varchar(1024)`,
      );
    }
    if (!table.columns.some((column) => column.name === 'storagePurgedAt')) {
      await queryRunner.query(
        `ALTER TABLE "telegram_bot_file_grants" ADD COLUMN "storagePurgedAt" datetime`,
      );
    }

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_bot_grants_purge_sweep"`
      + ` ON "telegram_bot_file_grants" ("storageBackend", "storagePurgedAt", "expiresAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'better-sqlite3') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_bot_grants_purge_sweep"`);
  }
}
