import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Telegram 账号主数据表（SQLite 方言）。
 *
 * 全新库由 SQLite 基线（SqliteEntitySchema）按实体元数据建表；存量库基线已执行
 * 不会重跑，故此处在 `*-Sqlite*` 链中用 `CREATE TABLE IF NOT EXISTS` 幂等补齐。
 *
 * 注意：本文件必须带 `-Sqlite` 后缀，否则不会被正式 SQLite 迁移 glob 加载。
 */
export class SqliteCreateTelegramAccounts1803000000000 implements MigrationInterface {
  name = 'SqliteCreateTelegramAccounts1803000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_accounts" (
        "id" varchar PRIMARY KEY NOT NULL,
        "type" varchar(8) NOT NULL,
        "name" varchar(64) NOT NULL,
        "externalId" varchar(64),
        "status" varchar(16) NOT NULL DEFAULT 'pending_auth',
        "enabled" boolean NOT NULL DEFAULT 0,
        "weight" integer NOT NULL DEFAULT 1,
        "maxInflight" integer NOT NULL DEFAULT 8,
        "primaryChatId" varchar(32),
        "credentialCiphertext" text,
        "credentialVersion" varchar(16),
        "capabilities" varchar,
        "lastHealthCheckAt" datetime,
        "lastSuccessAt" datetime,
        "lastFailureAt" datetime,
        "lastFailureCode" varchar(64),
        "lastFailureSummary" varchar(500),
        "note" varchar(255),
        "createdBy" varchar(64),
        "updatedBy" varchar(64),
        "disabledAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_accounts_type_external"`
      + ` ON "telegram_accounts" ("type", "externalId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_accounts_status"`
      + ` ON "telegram_accounts" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_accounts_enabled"`
      + ` ON "telegram_accounts" ("enabled")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    // SQLite 旧版本不支持 DROP COLUMN；删表不自动删索引，显式清理后再删表。
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_accounts_enabled"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_accounts_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_tg_accounts_type_external"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_accounts"`);
  }
}
