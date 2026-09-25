import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 修复 3 张 Telegram Bot 表 `id` 缺失的默认值（PostgreSQL）。
 *
 * 与 `FixApiKeysIdDefault1801000000001` 同型事故：`TelegramBotLinks1802300000000`
 * 建表时将 `"id"` 声明为 `uuid NOT NULL` 但遗漏了 DEFAULT 表达式。
 * `@PrimaryGeneratedColumn('uuid')` 在 PG 下**不做应用层生成**——`database.config.ts`
 * 的 postgres 分支不注册 `UuidSubscriber`（该 subscriber 仅服务 SQLite），
 * 因此 INSERT 省略 id 时依赖数据库端默认值，缺失即违反非空约束（23502）。
 *
 * 影响面：直链签发（`telegram_bot_file_grants`）、每日配额（`telegram_bot_daily_usage`）、
 * 白名单维护（`telegram_bot_whitelist`）三条写入路径 100% 失败。
 *
 * - 仅补充列默认值元数据（ALTER COLUMN ... SET DEFAULT），不重建表、
 *   不回填或改写已有 id，瞬时持有表锁但无数据扫描；
 * - 使用 `ALTER TABLE IF EXISTS`：未执行 180230 的环境为无操作；
 * - 重复执行幂等（SET DEFAULT 可重复应用）；
 * - gen_random_uuid() 为 PG13+ 内置，与 1797000000000 / 1802100000000 等迁移保持一致；
 * - 存量库（已应用 180230 建表）与空库（180230 建表 + 本迁移）
 *   两种路径均收敛到相同结构，因此历史迁移保持原样不再改动；
 * - 语句逐张表显式书写（不使用循环拼接表名），使
 *   `migration-uuid-default.spec.ts` 的静态守卫能直接读到表名。
 */
export class FixTelegramBotIdDefault1802400000000 implements MigrationInterface {
  name = 'FixTelegramBotIdDefault1802400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(
      `ALTER TABLE IF EXISTS "telegram_bot_file_grants" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "telegram_bot_daily_usage" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "telegram_bot_whitelist" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(
      `ALTER TABLE IF EXISTS "telegram_bot_file_grants" ALTER COLUMN "id" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "telegram_bot_daily_usage" ALTER COLUMN "id" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "telegram_bot_whitelist" ALTER COLUMN "id" DROP DEFAULT`,
    );
  }
}
