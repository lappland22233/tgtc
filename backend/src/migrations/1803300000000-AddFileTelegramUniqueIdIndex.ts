import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `files.telegramFileUniqueId` 建索引（PostgreSQL）。
 *
 * 为什么要索引：入站副本桥接（`FileCopyService.bridgeInboundCopyToLogicalFile`）会用
 * Telegram 跨账号稳定的 `file_unique_id` 反查站内逻辑文件，把「副本可见群里各账号认领到的
 * 副本」桥接成 `ownerType='file'` 的副本记录。该查询在**每条群内文件消息**上触发，
 * 且会按 Bot 数放大；没有索引时每次都是全表扫描。
 *
 * 为什么是**非唯一**索引：`file_unique_id` 在站内不唯一——同一内容被上传两次会形成
 * 两条 `files` 记录；唯一约束会直接让第二次上传失败，属于行为变更，绝不可取。
 *
 * 说明：`files` 表由既有迁移与 SQLite 基线建立，这里只做 expand 式增量（仅加索引）。
 */
export class AddFileTelegramUniqueIdIndex1803300000000 implements MigrationInterface {
  name = 'AddFileTelegramUniqueIdIndex1803300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_files_telegram_file_unique_id"`
      + ` ON "files" ("telegramFileUniqueId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_telegram_file_unique_id"`);
  }
}
