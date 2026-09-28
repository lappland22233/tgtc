import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Telegram Bot 文件直链（PostgreSQL）。
 * - 新增 telegram_bot_file_grants（直链授权，双轨 Token 存储 + 消息幂等锚点）；
 * - 新增 telegram_bot_daily_usage（每日配额，唯一 (用户, 业务日期)）；
 * - 新增 telegram_bot_whitelist（永久白名单）；
 * - access_logs 增加可空列 botGrantId / botTelegramUserId（Bot 使用情况统计）。
 *
 * 不建外键：Bot 记录与本站用户体系解耦；TG 用户 ID 用 varchar（可能超 32 位）。
 */
export class TelegramBotLinks1802300000000 implements MigrationInterface {
  name = 'TelegramBotLinks1802300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_bot_file_grants" (
        "id" uuid NOT NULL,
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
        "expiresAt" timestamptz NOT NULL,
        "revokedAt" timestamptz,
        "revokedBy" varchar(32),
        "accessCount" integer NOT NULL DEFAULT 0,
        "lastAccessedAt" timestamptz,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_telegram_bot_file_grants_id" PRIMARY KEY ("id")
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
        "id" uuid NOT NULL,
        "telegramUserId" varchar(32) NOT NULL,
        "usageDate" varchar(10) NOT NULL,
        "issuedCount" integer NOT NULL DEFAULT 0,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_telegram_bot_daily_usage_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_bot_daily_usage_user_date" ON "telegram_bot_daily_usage" ("telegramUserId", "usageDate")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_bot_whitelist" (
        "id" uuid NOT NULL,
        "telegramUserId" varchar(32) NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "source" varchar(16) NOT NULL DEFAULT 'admin',
        "createdBy" varchar(32),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_telegram_bot_whitelist_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_bot_whitelist_tgUser" ON "telegram_bot_whitelist" ("telegramUserId")`,
    );

    await queryRunner.query(`
      ALTER TABLE "access_logs"
        ADD COLUMN IF NOT EXISTS "botGrantId" uuid,
        ADD COLUMN IF NOT EXISTS "botTelegramUserId" varchar(32)
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_access_logs_botGrantId" ON "access_logs" ("botGrantId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_access_logs_botGrantId"`);
    await queryRunner.query(`
      ALTER TABLE "access_logs"
        DROP COLUMN IF EXISTS "botGrantId",
        DROP COLUMN IF EXISTS "botTelegramUserId"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_bot_whitelist"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_bot_daily_usage"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_bot_file_grants"`);
  }
}
