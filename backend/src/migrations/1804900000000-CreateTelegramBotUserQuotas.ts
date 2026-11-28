import { MigrationInterface, QueryRunner } from 'typeorm';
import { createBotUserQuotaTable } from './bot-user-quota-schema';

/**
 * 单账号每日额度覆盖（PostgreSQL）。
 *
 * 与 `1804900000000-SqliteCreateTelegramBotUserQuotas` 成对：两个文件各自按方言早退，
 * 否则成对的迁移 glob 会在同一库上双跑。
 */
export class CreateTelegramBotUserQuotas1804900000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (runner.dataSource.options.type !== 'postgres') return;
    await createBotUserQuotaTable(runner, false);
  }

  async down(runner: QueryRunner): Promise<void> {
    if (runner.dataSource.options.type !== 'postgres') return;
    await runner.query('DROP TABLE IF EXISTS "telegram_bot_user_quotas"');
  }
}
