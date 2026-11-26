import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `files` 与 `telegram_bot_file_grants` 增加 Google 缓存重试三列（PostgreSQL）。
 *
 * 背景：Google 双写此前是"一次性尽力而为"，失败只打日志且状态永远停在 none。
 * 这三列把双写变成可重试的状态机：
 * - `gdriveCacheAttempts`: 已尝试次数（退避依据）；
 * - `gdriveCacheLastError`: 最近一次失败原因；
 * - `gdriveCacheNextRetryAt`: 下次重试时间（pending 时兼作 10 分钟租约）。
 */
export class AddGDriveCacheRetryColumns1804800000000 implements MigrationInterface {
  name = 'AddGDriveCacheRetryColumns1804800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;

    for (const table of ['files', 'telegram_bot_file_grants']) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "gdriveCacheAttempts" integer NOT NULL DEFAULT 0`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "gdriveCacheLastError" varchar(500)`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "gdriveCacheNextRetryAt" TIMESTAMP WITH TIME ZONE`,
      );
    }
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "idx_files_gdrive_cache_sweep"'
      + ' ON "files" ("gdriveCacheStatus", "gdriveCacheNextRetryAt")',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "idx_tg_bot_grants_gdrive_cache_sweep"'
      + ' ON "telegram_bot_file_grants" ("gdriveCacheStatus", "gdriveCacheNextRetryAt")',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;

    await queryRunner.query('DROP INDEX IF EXISTS "idx_tg_bot_grants_gdrive_cache_sweep"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_files_gdrive_cache_sweep"');
    for (const table of ['files', 'telegram_bot_file_grants']) {
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "gdriveCacheNextRetryAt"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "gdriveCacheLastError"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "gdriveCacheAttempts"`);
    }
  }
}
