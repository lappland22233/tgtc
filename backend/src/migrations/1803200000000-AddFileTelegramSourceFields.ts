import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `files` 表补齐主副本远端定位字段（PostgreSQL）。
 *
 * 为什么需要：`telegramFileId` 只能取流，无法回答「哪条消息、哪个群、哪个账号
 * 产生」。用户账号无源复制（MTProto copyMessages）必须持有源 `chat_id +
 * message_id`；镜像任务、副本归属校验与按账号回源也需要账号锚点与 `file_unique_id`。
 *
 * 全部为**可空列**：历史数据与单账号路径保持原状，不写这些字段也能正常工作。
 */
export class AddFileTelegramSourceFields1803200000000 implements MigrationInterface {
  name = 'AddFileTelegramSourceFields1803200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(
      `ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "telegramChatId" varchar(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "telegramMessageId" varchar(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "telegramFileUniqueId" varchar(256)`,
    );
    await queryRunner.query(
      `ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "telegramSourceAccountId" varchar(64)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "telegramSourceAccountId"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "telegramFileUniqueId"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "telegramMessageId"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "telegramChatId"`);
  }
}
