import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `files` 与 `telegram_bot_file_grants` 表新增 Google 缓存三列（PostgreSQL）。
 *
 * 字段说明：
 * - `gdriveCacheAccountId`: Google 缓存所在的 GDrive 账号 ID；
 * - `gdriveCacheObjectRef`: Google 缓存远端对象引用（Google Drive fileId）；
 * - `gdriveCacheStatus`: 缓存状态（'none' | 'pending' | 'ready' | 'failed'），默认 'none'。
 */
export class AddGDriveCacheColumns1804300000000 implements MigrationInterface {
  name = 'AddGDriveCacheColumns1804300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;

    // files 表增加 Google 缓存列
    await queryRunner.query(
      `ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "gdriveCacheAccountId" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "gdriveCacheObjectRef" varchar(1024)`,
    );
    await queryRunner.query(
      `ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "gdriveCacheStatus" varchar(16) DEFAULT 'none'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_files_gdrive_cache_ref"`
      + ` ON "files" ("gdriveCacheAccountId", "gdriveCacheObjectRef")`,
    );

    // telegram_bot_file_grants 表增加 Google 缓存列
    await queryRunner.query(
      `ALTER TABLE "telegram_bot_file_grants" ADD COLUMN IF NOT EXISTS "gdriveCacheAccountId" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "telegram_bot_file_grants" ADD COLUMN IF NOT EXISTS "gdriveCacheObjectRef" varchar(1024)`,
    );
    await queryRunner.query(
      `ALTER TABLE "telegram_bot_file_grants" ADD COLUMN IF NOT EXISTS "gdriveCacheStatus" varchar(16) DEFAULT 'none'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_bot_grants_gdrive_cache_ref"`
      + ` ON "telegram_bot_file_grants" ("gdriveCacheAccountId", "gdriveCacheObjectRef")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_bot_grants_gdrive_cache_ref"`);
    await queryRunner.query(`ALTER TABLE "telegram_bot_file_grants" DROP COLUMN IF EXISTS "gdriveCacheStatus"`);
    await queryRunner.query(`ALTER TABLE "telegram_bot_file_grants" DROP COLUMN IF EXISTS "gdriveCacheObjectRef"`);
    await queryRunner.query(`ALTER TABLE "telegram_bot_file_grants" DROP COLUMN IF EXISTS "gdriveCacheAccountId"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_gdrive_cache_ref"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "gdriveCacheStatus"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "gdriveCacheObjectRef"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "gdriveCacheAccountId"`);
  }
}
