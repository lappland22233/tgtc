import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SQLite 方言：启用中且已允许 Web 上传扩散的规则同时接收 Bot 私聊入站事件。
 * 保留未启用/仅 Bot 特定范围以外的规则，并允许管理员之后显式关闭 Bot 入站。
 */
export class SqliteEnableBotInboundMirrorForEnabledRules1803800000000 implements MigrationInterface {
  name = 'SqliteEnableBotInboundMirrorForEnabledRules1803800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    const table = await queryRunner.getTable('telegram_mirror_rules');
    if (!table?.columns.some((column) => column.name === 'includeBotInboundFiles')) return;
    await queryRunner.query(`
      UPDATE "telegram_mirror_rules"
      SET "includeBotInboundFiles" = 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "enabled" = 1
        AND "includeWebUploads" = 1
        AND "includeBotInboundFiles" = 0
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Do not undo persisted rule choices; operators may have edited them after this migration.
  }
}
