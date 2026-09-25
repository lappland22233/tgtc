import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Telegram Bot 文件直链（SQLite 方言）。
 * 全新库三张表由 SQLite 基线按实体元数据创建；存量库基线已执行不会重跑，
 * 此处使用 CREATE TABLE IF NOT EXISTS 补齐（幂等），并为 access_logs 补列。
 */
export class SqliteTelegramBotLinks1802300000000 implements MigrationInterface {
  name = 'SqliteTelegramBotLinks1802300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_bot_file_grants" (
        "id" varchar PRIMARY KEY NOT NULL,
        "telegramUserId" varchar(32) NOT NULL,
        "telegramUsername" varchar(64),
        "telegramDisplayName" varchar(128),
        "chatId" varchar(32) NOT NULL,
        "messageId" varchar(32) NOT NULL,
        "telegramFileId" varchar(512) NOT NULL,
        "fileName" varchar(255),
        "mimeType" varchar(128),
        "fileSize" bigint,
        "tokenHash" varchar(64) NOT NULL,
        "tokenCipher" varchar(1024),
        "tokenPrefix" varchar(16) NOT NULL,
        "cipherVersion" varchar(16),
        "expiresAt" datetime NOT NULL,
        "revokedAt" datetime,
        "revokedBy" varchar(32),
        "accessCount" integer NOT NULL DEFAULT 0,
        "lastAccessedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_bot_grants_tokenHash" ON "telegram_bot_file_grants" ("tokenHash")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_bot_grants_message" ON "telegram_bot_file_grants" ("telegramUserId", "chatId", "messageId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_bot_grants_tgUser" ON "telegram_bot_file_grants" ("telegramUserId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_bot_grants_expiresAt" ON "telegram_bot_file_grants" ("expiresAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_bot_daily_usage" (
        "id" varchar PRIMARY KEY NOT NULL,
        "telegramUserId" varchar(32) NOT NULL,
        "usageDate" varchar(10) NOT NULL,
        "issuedCount" integer NOT NULL DEFAULT 0,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_bot_daily_usage_user_date" ON "telegram_bot_daily_usage" ("telegramUserId", "usageDate")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_bot_whitelist" (
        "id" varchar PRIMARY KEY NOT NULL,
        "telegramUserId" varchar(32) NOT NULL,
        "enabled" boolean NOT NULL DEFAULT 1,
        "source" varchar(16) NOT NULL DEFAULT 'admin',
        "createdBy" varchar(32),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_bot_whitelist_tgUser" ON "telegram_bot_whitelist" ("telegramUserId")`,
    );

    const accessLogTable = await queryRunner.getTable('access_logs');
    if (accessLogTable && !accessLogTable.columns.some((c) => c.name === 'botGrantId')) {
      await queryRunner.query(`ALTER TABLE "access_logs" ADD COLUMN "botGrantId" varchar`);
    }
    if (accessLogTable && !accessLogTable.columns.some((c) => c.name === 'botTelegramUserId')) {
      await queryRunner.query(`ALTER TABLE "access_logs" ADD COLUMN "botTelegramUserId" varchar(32)`);
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_access_logs_botGrantId" ON "access_logs" ("botGrantId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    // SQLite 不支持 DROP COLUMN（旧版）；保留列即可，无数据风险。
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_bot_whitelist"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_bot_daily_usage"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_bot_file_grants"`);
  }
}
