import { MigrationInterface, QueryRunner } from 'typeorm';

export class SqliteScopeBotGrantMessage1804400000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (runner.dataSource.options.type !== 'better-sqlite3') return;
    if (!(await runner.hasColumn('telegram_bot_file_grants', 'receiverBotId'))) {
      await runner.query('ALTER TABLE "telegram_bot_file_grants" ADD COLUMN "receiverBotId" varchar(32)');
    }
    await runner.query('DROP INDEX IF EXISTS "uq_tg_bot_grants_message"');
    await runner.query('CREATE UNIQUE INDEX "uq_tg_bot_grants_message" ON "telegram_bot_file_grants" ("receiverBotId", "telegramUserId", "chatId", "messageId")');
    await runner.query('CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_bot_grants_legacy_message" ON "telegram_bot_file_grants" ("telegramUserId", "chatId", "messageId") WHERE "receiverBotId" IS NULL');
  }

  async down(runner: QueryRunner): Promise<void> {
    if (runner.dataSource.options.type !== 'better-sqlite3') return;
    // Recreate the old uniqueness rule first. If two bots now share a message number,
    // reverting would lose data and must fail before changing the current schema.
    await runner.query('CREATE UNIQUE INDEX "uq_tg_bot_grants_revert_guard" ON "telegram_bot_file_grants" ("telegramUserId", "chatId", "messageId")');
    await runner.query('DROP INDEX IF EXISTS "uq_tg_bot_grants_message"');
    await runner.query('DROP INDEX IF EXISTS "uq_tg_bot_grants_legacy_message"');
    await runner.query('ALTER TABLE "telegram_bot_file_grants" DROP COLUMN "receiverBotId"');
    await runner.query('CREATE UNIQUE INDEX "uq_tg_bot_grants_message" ON "telegram_bot_file_grants" ("telegramUserId", "chatId", "messageId")');
    await runner.query('DROP INDEX "uq_tg_bot_grants_revert_guard"');
  }
}
