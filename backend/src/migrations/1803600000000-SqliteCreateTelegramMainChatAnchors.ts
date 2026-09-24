import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 主群锚点表（SQLite 独立基线链）。
 *
 * 与 `1803600000000-CreateTelegramMainChatAnchors.ts` 同义，仅方言差异：
 * - 全新库由 SQLite 基线（`SqliteEntitySchema`）按实体元数据建表；存量库基线已执行
 *   不会重跑，故此处在 `*-Sqlite*` 链中用 `CREATE TABLE IF NOT EXISTS` 幂等补齐；
 * - `timestamptz` → `datetime`；时间默认值用 `datetime('now')`；
 * - uuid 主键在 SQLite 由 `UuidSubscriber` 应用层生成，主键列写 `varchar`。
 *
 * 注意：本文件必须带 `-Sqlite` 后缀，否则不会被 SQLite 迁移 glob 加载。
 */
export class SqliteCreateTelegramMainChatAnchors1803600000000 implements MigrationInterface {
  name = 'SqliteCreateTelegramMainChatAnchors1803600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_main_chat_anchors" (
        "id" varchar PRIMARY KEY NOT NULL,
        "ownerType" varchar(16) NOT NULL,
        "ownerId" varchar(64) NOT NULL,
        "anchorChatId" varchar(32) NOT NULL,
        "anchorMessageId" varchar(32),
        "plantedByAccountId" varchar(64),
        "sourceChatId" varchar(32),
        "sourceMessageId" varchar(32),
        "status" varchar(16) NOT NULL DEFAULT 'ready',
        "lastError" varchar(500),
        "plantedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_main_chat_anchors_owner"`
      + ` ON "telegram_main_chat_anchors" ("ownerType", "ownerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_main_chat_anchors_anchor"`
      + ` ON "telegram_main_chat_anchors" ("anchorChatId", "anchorMessageId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_main_chat_anchors_anchor"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_tg_main_chat_anchors_owner"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_main_chat_anchors"`);
  }
}
