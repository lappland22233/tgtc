import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Telegram 文件副本表 + Bot 直链「源账号」锚点（SQLite 方言）。
 *
 * 全新库由 SQLite 基线（SqliteEntitySchema）按实体元数据建表；存量库基线已执行
 * 不会重跑，故此处在 `*-Sqlite*` 链中用 `CREATE TABLE IF NOT EXISTS` 幂等补齐，
 * 并为 `telegram_bot_file_grants` 补 `sourceAccountId`（SQLite 不支持
 * `ADD COLUMN IF NOT EXISTS`，沿用 `getTable` 判定，与 180230/180260 一致）。
 *
 * 注意：本文件必须带 `-Sqlite` 后缀，否则不会被正式 SQLite 迁移 glob 加载。
 */
export class SqliteTelegramFileCopies1802900000000 implements MigrationInterface {
  name = 'SqliteTelegramFileCopies1802900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_file_copies" (
        "id" varchar PRIMARY KEY NOT NULL,
        "ownerType" varchar(16) NOT NULL,
        "ownerId" varchar(64) NOT NULL,
        "accountId" varchar(64) NOT NULL,
        "telegramFileId" varchar(512) NOT NULL,
        "chatId" varchar(32),
        "messageId" varchar(32),
        "fileSize" bigint,
        "source" varchar(16) NOT NULL DEFAULT 'inbound',
        "status" varchar(16) NOT NULL DEFAULT 'ready',
        "lastError" varchar(500),
        "lastUsedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_file_copies_owner_account"`
      + ` ON "telegram_file_copies" ("ownerType", "ownerId", "accountId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_file_copies_owner"`
      + ` ON "telegram_file_copies" ("ownerType", "ownerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_file_copies_status"`
      + ` ON "telegram_file_copies" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_file_copies_anchor"`
      + ` ON "telegram_file_copies" ("chatId", "messageId")`,
    );

    const grants = await queryRunner.getTable('telegram_bot_file_grants');
    if (grants && !grants.columns.some((column) => column.name === 'sourceAccountId')) {
      await queryRunner.query(
        `ALTER TABLE "telegram_bot_file_grants" ADD COLUMN "sourceAccountId" varchar(64)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    // SQLite 旧版本不支持 DROP COLUMN；保留列无数据风险（与既有迁移一致）。
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_file_copies"`);
  }
}
