import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `telegram_bot_file_grants` 表新增 `fileUniqueId` 列（PostgreSQL）。
 *
 * 为什么需要：镜像群/主群可能是频道，群内消息只携带 `file_unique_id`（跨账号稳定），
 * 而 grant 只有 `(telegramUserId, chatId, messageId)` 私聊锚点 + 账号级 `telegramFileId`，
 * 无法把「群内某条消息的认领」归因回某条 grant —— 扩散轮次结算
 * （sweeper 按 `grant:<id>` 查 ready 副本）恒为空，误判 `claim_timeout`。
 * 本列为该归因提供索引键。
 *
 * 全部为**可空列**：历史数据保持 NULL，不写该列也不影响既有直链链路。
 */
export class AddGrantFileUniqueId1803700000000 implements MigrationInterface {
  name = 'AddGrantFileUniqueId1803700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(
      `ALTER TABLE "telegram_bot_file_grants" ADD COLUMN IF NOT EXISTS "fileUniqueId" varchar(128)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_bot_grants_fileUniqueId"`
      + ` ON "telegram_bot_file_grants" ("fileUniqueId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    // 逆序：先删索引，再删列
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_bot_grants_fileUniqueId"`);
    await queryRunner.query(`ALTER TABLE "telegram_bot_file_grants" DROP COLUMN IF EXISTS "fileUniqueId"`);
  }
}
