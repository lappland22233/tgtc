import type { QueryRunner } from 'typeorm';

/**
 * `telegram_bot_user_quotas` 建表（PG / SQLite 共用）。
 *
 * 幂等：全部使用 `IF NOT EXISTS`，迁移重放不会报错。
 */
export async function createBotUserQuotaTable(runner: QueryRunner, sqlite: boolean): Promise<void> {
  const timestamp = sqlite ? 'datetime' : 'timestamptz';
  // SQLite 的表达式默认值必须加括号：`DEFAULT (datetime('now'))`，否则是语法错误
  const defaultNow = sqlite ? "(datetime('now'))" : 'now()';
  await runner.query(`CREATE TABLE IF NOT EXISTS "telegram_bot_user_quotas" (
    "telegramUserId" varchar(32) NOT NULL PRIMARY KEY,
    "dailyLimit" integer NOT NULL,
    "createdBy" varchar(64),
    "createdAt" ${timestamp} NOT NULL DEFAULT ${defaultNow},
    "updatedAt" ${timestamp} NOT NULL DEFAULT ${defaultNow}
  )`);
}
