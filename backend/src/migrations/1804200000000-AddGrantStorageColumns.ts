import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `telegram_bot_file_grants` 表新增存储后端判别与清理跟踪四列（PostgreSQL）。
 *
 * 字段说明：
 * - `storageBackend`: 存储后端类型（'telegram' | 'gdrive'），默认 'telegram'；
 * - `storageAccountId`: 存储账号 ID（非 TG 后端）；
 * - `storageObjectRef`: 远端对象引用（Google Drive fileId）；
 * - `storagePurgedAt`: 远端对象物理删除时间戳，防止定时清理重复处理。
 */
export class AddGrantStorageColumns1804200000000 implements MigrationInterface {
  name = 'AddGrantStorageColumns1804200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(
      `ALTER TABLE "telegram_bot_file_grants" ADD COLUMN IF NOT EXISTS "storageBackend" varchar(16) NOT NULL DEFAULT 'telegram'`,
    );
    await queryRunner.query(
      `ALTER TABLE "telegram_bot_file_grants" ADD COLUMN IF NOT EXISTS "storageAccountId" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "telegram_bot_file_grants" ADD COLUMN IF NOT EXISTS "storageObjectRef" varchar(1024)`,
    );
    await queryRunner.query(
      `ALTER TABLE "telegram_bot_file_grants" ADD COLUMN IF NOT EXISTS "storagePurgedAt" TIMESTAMP WITH TIME ZONE`,
    );

    // 覆盖定时扫描索引：快速查找到期且未清理的远端文件
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_bot_grants_purge_sweep"`
      + ` ON "telegram_bot_file_grants" ("storageBackend", "storagePurgedAt", "expiresAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_bot_grants_purge_sweep"`);
    await queryRunner.query(`ALTER TABLE "telegram_bot_file_grants" DROP COLUMN IF EXISTS "storagePurgedAt"`);
    await queryRunner.query(`ALTER TABLE "telegram_bot_file_grants" DROP COLUMN IF EXISTS "storageObjectRef"`);
    await queryRunner.query(`ALTER TABLE "telegram_bot_file_grants" DROP COLUMN IF EXISTS "storageAccountId"`);
    await queryRunner.query(`ALTER TABLE "telegram_bot_file_grants" DROP COLUMN IF EXISTS "storageBackend"`);
  }
}
