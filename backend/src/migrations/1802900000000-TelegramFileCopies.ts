import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Telegram 文件副本表 + Bot 直链「源账号」锚点（PostgreSQL）。
 *
 * 背景：`file_id` 按 Bot 账号隔离，同一文件在各账号下是不同的 `file_id`；
 * 「按负载挑一个账号回源」的前提是每个候选账号都持有自己的副本记录。
 * 本表即「逻辑文件（file_unique_id / file / grant） → 账号 → file_id」映射，并承担：
 * - 入站归属登记（source=inbound）；
 * - 副本扩散结果（source=replicated）；
 * - 用户账号中继后各账号自行取得（source=relayed）。
 *
 * 采用 expand 式增量：只新增表、可空列与索引，**不删改任何旧字段与旧路径**，
 * 因此旧版本代码可继续读写旧 schema（deploy 阶段账号池保持关闭）。
 *
 * 关键约束：
 * - `id` 为 UUID 主键并带库端默认值（`@PrimaryGeneratedColumn('uuid')` 在 PG 下
 *   不做应用层生成，漏写默认值会让整表写入 100% 报 23502）；
 * - `(ownerType, ownerId, accountId)` 唯一（重投幂等）；
 * - `(chatId, messageId)` 入站锚点索引（由用户消息反查逻辑主键）；
 * - 不建外键：与站内用户体系、Bot 授权体系解耦，便于独立清理。
 */
export class TelegramFileCopies1802900000000 implements MigrationInterface {
  name = 'TelegramFileCopies1802900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_file_copies" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
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
        "lastUsedAt" timestamptz,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_telegram_file_copies_id" PRIMARY KEY ("id")
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

    // 回退安全锚点：记录「产生该 file_id 的账号」。池化入站时写入收到消息的账号 ID；
    // 允许为空（旧数据/单账号路径不写），为空时禁止把该 file_id 交给其它账号回源。
    await queryRunner.query(
      `ALTER TABLE "telegram_bot_file_grants" ADD COLUMN IF NOT EXISTS "sourceAccountId" varchar(64)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(
      `ALTER TABLE "telegram_bot_file_grants" DROP COLUMN IF EXISTS "sourceAccountId"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_file_copies_anchor"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_file_copies_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_file_copies_owner"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_tg_file_copies_owner_account"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_file_copies"`);
  }
}
