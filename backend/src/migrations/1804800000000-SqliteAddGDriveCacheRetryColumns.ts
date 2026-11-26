import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `files` 与 `telegram_bot_file_grants` 增加 Google 缓存重试三列（SQLite 方言）。
 * 列语义与 PostgreSQL 版本一致；SQLite 不支持 DROP COLUMN 的统一回滚，down 只删索引。
 */
export class SqliteAddGDriveCacheRetryColumns1804800000000 implements MigrationInterface {
  name = 'SqliteAddGDriveCacheRetryColumns1804800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'better-sqlite3') return;

    const filesTable = await queryRunner.getTable('files');
    if (filesTable) {
      if (!filesTable.columns.some((c) => c.name === 'gdriveCacheAttempts')) {
        await queryRunner.query(`ALTER TABLE "files" ADD COLUMN "gdriveCacheAttempts" integer NOT NULL DEFAULT 0`);
      }
      if (!filesTable.columns.some((c) => c.name === 'gdriveCacheLastError')) {
        await queryRunner.query(`ALTER TABLE "files" ADD COLUMN "gdriveCacheLastError" varchar(500)`);
      }
      if (!filesTable.columns.some((c) => c.name === 'gdriveCacheNextRetryAt')) {
        await queryRunner.query(`ALTER TABLE "files" ADD COLUMN "gdriveCacheNextRetryAt" datetime`);
      }
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "idx_files_gdrive_cache_sweep"`
        + ` ON "files" ("gdriveCacheStatus", "gdriveCacheNextRetryAt")`,
      );
    }

    const grantsTable = await queryRunner.getTable('telegram_bot_file_grants');
    if (grantsTable) {
      if (!grantsTable.columns.some((c) => c.name === 'gdriveCacheAttempts')) {
        await queryRunner.query(`ALTER TABLE "telegram_bot_file_grants" ADD COLUMN "gdriveCacheAttempts" integer NOT NULL DEFAULT 0`);
      }
      if (!grantsTable.columns.some((c) => c.name === 'gdriveCacheLastError')) {
        await queryRunner.query(`ALTER TABLE "telegram_bot_file_grants" ADD COLUMN "gdriveCacheLastError" varchar(500)`);
      }
      if (!grantsTable.columns.some((c) => c.name === 'gdriveCacheNextRetryAt')) {
        await queryRunner.query(`ALTER TABLE "telegram_bot_file_grants" ADD COLUMN "gdriveCacheNextRetryAt" datetime`);
      }
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "idx_tg_bot_grants_gdrive_cache_sweep"`
        + ` ON "telegram_bot_file_grants" ("gdriveCacheStatus", "gdriveCacheNextRetryAt")`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'better-sqlite3') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_bot_grants_gdrive_cache_sweep"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_gdrive_cache_sweep"`);
  }
}
