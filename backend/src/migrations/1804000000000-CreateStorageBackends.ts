import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 存储后端账号表（PostgreSQL）。
 *
 * ## 背景
 *
 * 可插拔存储改造：文件存储不再限于 Telegram。S3 一套密钥、WebDAV 一个端点、
 * GDrive 一个 Google 账号都是一行「存储账号」，由通用调度器按
 * 「带宽 × 健康度 × 容量 × 权重（× 剩余配额）」选号，实现账号池扩容。
 *
 * ## 设计要点
 *
 * - `(type, name)` 唯一：同一后端类型下不允许重名账号；
 * - `credentialCiphertext` 只存 AES-256-GCM 密文（独立根密钥 STORAGE_ENCRYPTION_KEY），
 *   永不回显；撤销账号清空凭据但保留行（存量文件引用保持可诊断）；
 * - 配额三列可空：S3/WebDAV 无配额概念（null），GDrive 个人账号 15GB；
 * - `id` 为 UUID 主键并带库端默认值（与 telegram_main_chat_anchors 同款防 23502）；
 * - 不建外键：与站内文件体系解耦，files.storageAccountId 仅逻辑引用。
 *
 * 采用 expand 式增量：只新增表与索引，不删改任何旧字段与旧路径。
 */
export class CreateStorageBackends1804000000000 implements MigrationInterface {
  name = 'CreateStorageBackends1804000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "storage_backends" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "type" varchar(16) NOT NULL,
        "name" varchar(64) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'active',
        "enabled" boolean NOT NULL DEFAULT false,
        "weight" integer NOT NULL DEFAULT 1,
        "maxInflight" integer NOT NULL DEFAULT 8,
        "config" jsonb,
        "credentialCiphertext" text,
        "credentialVersion" varchar(16),
        "quotaTotalBytes" bigint,
        "quotaUsedBytes" bigint,
        "lastQuotaCheckAt" timestamptz,
        "lastHealthCheckAt" timestamptz,
        "lastSuccessAt" timestamptz,
        "lastFailureAt" timestamptz,
        "lastFailureCode" varchar(64),
        "lastFailureSummary" varchar(500),
        "note" varchar(255),
        "createdBy" varchar(64),
        "updatedBy" varchar(64),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_storage_backends_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_storage_backends_type_name"`
      + ` ON "storage_backends" ("type", "name")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_storage_backends_status" ON "storage_backends" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_storage_backends_enabled" ON "storage_backends" ("enabled")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_storage_backends_enabled"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_storage_backends_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_storage_backends_type_name"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "storage_backends"`);
  }
}