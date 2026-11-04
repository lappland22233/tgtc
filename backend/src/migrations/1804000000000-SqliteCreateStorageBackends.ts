import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 存储后端账号表（SQLite 独立基线链）。
 *
 * 与 `1804000000000-CreateStorageBackends.ts` 同义，仅方言差异：
 * - 全新库由 SQLite 基线（`SqliteEntitySchema`）按实体元数据建表；存量库基线已执行
 *   不会重跑，故此处在 `*-Sqlite*` 链中用 `CREATE TABLE IF NOT EXISTS` 幂等补齐；
 * - `jsonb` → `simple-json`（text）；`timestamptz` → `datetime`；
 * - uuid 主键在 SQLite 由 `UuidSubscriber` 应用层生成，主键列写 `varchar`。
 *
 * 注意：本文件必须带 `-Sqlite` 后缀，否则不会被 SQLite 迁移 glob 加载。
 */
export class SqliteCreateStorageBackends1804000000000 implements MigrationInterface {
  name = 'SqliteCreateStorageBackends1804000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "storage_backends" (
        "id" varchar PRIMARY KEY NOT NULL,
        "type" varchar(16) NOT NULL,
        "name" varchar(64) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'active',
        "enabled" boolean NOT NULL DEFAULT 0,
        "weight" integer NOT NULL DEFAULT 1,
        "maxInflight" integer NOT NULL DEFAULT 8,
        "config" text,
        "credentialCiphertext" text,
        "credentialVersion" varchar(16),
        "quotaTotalBytes" bigint,
        "quotaUsedBytes" bigint,
        "lastQuotaCheckAt" datetime,
        "lastHealthCheckAt" datetime,
        "lastSuccessAt" datetime,
        "lastFailureAt" datetime,
        "lastFailureCode" varchar(64),
        "lastFailureSummary" varchar(500),
        "note" varchar(255),
        "createdBy" varchar(64),
        "updatedBy" varchar(64),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
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
    if (queryRunner.connection.options.type !== 'sqlite') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_storage_backends_enabled"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_storage_backends_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_storage_backends_type_name"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "storage_backends"`);
  }
}