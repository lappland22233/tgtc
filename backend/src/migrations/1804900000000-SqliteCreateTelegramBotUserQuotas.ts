import { MigrationInterface, QueryRunner } from 'typeorm';
import { createBotUserQuotaTable } from './bot-user-quota-schema';

/** 单账号每日额度覆盖（SQLite）。见 PG 版本的同名迁移。 */
export class SqliteCreateTelegramBotUserQuotas1804900000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (runner.dataSource.options.type !== 'better-sqlite3') return;
    await createBotUserQuotaTable(runner, true);
  }

  async down(runner: QueryRunner): Promise<void> {
    if (runner.dataSource.options.type !== 'better-sqlite3') return;
    await runner.query('DROP TABLE IF EXISTS "telegram_bot_user_quotas"');
  }
}
