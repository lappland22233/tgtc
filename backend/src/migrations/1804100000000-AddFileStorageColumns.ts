import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `files` 表新增存储后端判别三列（PostgreSQL）。
 *
 * 为什么需要：可插拔存储改造后，文件的远端引用不再只有 Telegram——
 * `storageBackend` 判别后端类型，`storageAccountId + storageObjectRef` 是
 * 非 TG 后端的权威引用（S3 key / WebDAV 路径 / GDrive fileId）。
 *
 * 兼容性：`storageBackend` 默认 'telegram'，存量行自动落入 TG 分支，
 * 行为逐字节不变；另两列可空，历史数据保持 NULL。
 * 上传会话创建时冻结后端类型，配置热切换不影响在途任务。
 */
export class AddFileStorageColumns1804100000000 implements MigrationInterface {
  name = 'AddFileStorageColumns1804100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(
      `ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "storageBackend" varchar(16) NOT NULL DEFAULT 'telegram'`,
    );
    await queryRunner.query(
      `ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "storageAccountId" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "storageObjectRef" varchar(1024)`,
    );
    // 永久删除/覆盖清理的共享引用检查按 (storageAccountId, storageObjectRef) 计数
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_files_storage_ref"`
      + ` ON "files" ("storageAccountId", "storageObjectRef")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_storage_ref"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "storageObjectRef"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "storageAccountId"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "storageBackend"`);
  }
}