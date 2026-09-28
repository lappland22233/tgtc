import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Telegram 账号主数据表（PostgreSQL）。
 *
 * 背景：账号池此前只能从环境变量解析账号，管理员无法在后台查看/添加/停用/轮换，
 * 也无法记录健康与能力状态。本表把账号提升为运行时主数据，环境变量退化为
 * 「首次默认值 + 紧急强制关闭」。
 *
 * 采用 expand 式增量：只新增表与索引，**不删改任何旧字段与旧路径**，因此旧版本
 * 代码可继续读写旧 schema（deploy 阶段账号池保持关闭）。
 *
 * 关键约束：
 * - `id` 为 UUID 主键并带库端默认值（`@PrimaryGeneratedColumn('uuid')` 在 PG 下
 *   不做应用层生成，漏写默认值会让整表写入 100% 报 23502）；
 * - `(type, externalId)` 唯一：同一 Bot / 同一 TG 用户不允许重复登记；
 * - 凭据只存密文（`credentialCiphertext`），明文永不落库、永不回显。
 */
export class CreateTelegramAccounts1803000000000 implements MigrationInterface {
  name = 'CreateTelegramAccounts1803000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_accounts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "type" varchar(8) NOT NULL,
        "name" varchar(64) NOT NULL,
        "externalId" varchar(64),
        "status" varchar(16) NOT NULL DEFAULT 'pending_auth',
        "enabled" boolean NOT NULL DEFAULT false,
        "weight" int NOT NULL DEFAULT 1,
        "maxInflight" int NOT NULL DEFAULT 8,
        "primaryChatId" varchar(32),
        "credentialCiphertext" text,
        "credentialVersion" varchar(16),
        "capabilities" jsonb,
        "lastHealthCheckAt" timestamptz,
        "lastSuccessAt" timestamptz,
        "lastFailureAt" timestamptz,
        "lastFailureCode" varchar(64),
        "lastFailureSummary" varchar(500),
        "note" varchar(255),
        "createdBy" varchar(64),
        "updatedBy" varchar(64),
        "disabledAt" timestamptz,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_telegram_accounts_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_accounts_type_external"`
      + ` ON "telegram_accounts" ("type", "externalId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_accounts_status"`
      + ` ON "telegram_accounts" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_accounts_enabled"`
      + ` ON "telegram_accounts" ("enabled")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_accounts_enabled"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_accounts_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_tg_accounts_type_external"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_accounts"`);
  }
}
