import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 镜像备份规则与镜像任务表（SQLite 方言）。
 *
 * 全新库由 SQLite 基线按实体元数据建表；存量库基线已执行不会重跑，故此处用
 * `CREATE TABLE IF NOT EXISTS` 幂等补齐。索引与 PG 侧保持同名同列，便于运维核对。
 *
 * 注意：本文件必须带 `-Sqlite` 后缀，否则不会被正式 SQLite 迁移 glob 加载。
 */
export class SqliteCreateTelegramMirror1803100000000 implements MigrationInterface {
  name = 'SqliteCreateTelegramMirror1803100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_mirror_rules" (
        "id" varchar PRIMARY KEY NOT NULL,
        "enabled" boolean NOT NULL DEFAULT 0,
        "name" varchar(64) NOT NULL,
        "sourceChatId" varchar(32) NOT NULL,
        "targetChatId" varchar(32) NOT NULL,
        "mode" varchar(16) NOT NULL DEFAULT 'bot_upload',
        "preferredAccountId" varchar(64),
        "fallbackMode" varchar(16) NOT NULL DEFAULT 'disabled',
        "includeWebUploads" boolean NOT NULL DEFAULT 1,
        "includeBotInboundFiles" boolean NOT NULL DEFAULT 0,
        "lastTestedAt" datetime,
        "lastTestStatus" varchar(16) NOT NULL DEFAULT 'untested',
        "lastTestSummary" varchar(500),
        "createdBy" varchar(64),
        "updatedBy" varchar(64),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_mirror_rules_enabled"`
      + ` ON "telegram_mirror_rules" ("enabled")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_mirror_tasks" (
        "id" varchar PRIMARY KEY NOT NULL,
        "ruleId" varchar NOT NULL,
        "ownerType" varchar(16) NOT NULL,
        "ownerId" varchar(64) NOT NULL,
        "sourceVersion" integer NOT NULL DEFAULT 1,
        "sourceAccountId" varchar(64),
        "sourceChatId" varchar(32),
        "sourceMessageId" varchar(32),
        "targetAccountId" varchar(64),
        "mode" varchar(16) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'queued',
        "attempts" integer NOT NULL DEFAULT 0,
        "targetMessageId" varchar(32),
        "targetTelegramFileId" varchar(512),
        "targetChatId" varchar(32),
        "receiptPending" boolean NOT NULL DEFAULT 0,
        "lastErrorCode" varchar(64),
        "lastErrorSummary" varchar(500),
        "nextRetryAt" datetime,
        "startedAt" datetime,
        "completedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_mirror_tasks_idempotency"`
      + ` ON "telegram_mirror_tasks" ("ruleId", "ownerType", "ownerId", "sourceVersion")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_mirror_tasks_status"`
      + ` ON "telegram_mirror_tasks" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_mirror_tasks_rule_status"`
      + ` ON "telegram_mirror_tasks" ("ruleId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_mirror_tasks_next_retry"`
      + ` ON "telegram_mirror_tasks" ("nextRetryAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_mirror_tasks_next_retry"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_mirror_tasks_rule_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_mirror_tasks_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_tg_mirror_tasks_idempotency"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_mirror_tasks"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_mirror_rules_enabled"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_mirror_rules"`);
  }
}
