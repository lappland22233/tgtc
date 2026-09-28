import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bot 私聊入站文件加入镜像默认范围。
 *
 * 生产复核发现现有启用规则 includeBotInboundFiles=false，导致 Bot 收到 4GB 文件后
 * 不创建镜像任务，下载回源只能依赖单个来源 Bot。将已启用且已允许 Web 上传扩散的规则
 * 纳入 Bot 入站事件；新建规则的实体/服务默认值同步改为 true。未启用规则及明确关闭
 * Web 上传范围的规则保持原样。管理员之后仍可在规则上显式关闭 Bot 入站。
 */
export class EnableBotInboundMirrorForEnabledRules1803800000000 implements MigrationInterface {
  name = 'EnableBotInboundMirrorForEnabledRules1803800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`
      UPDATE "telegram_mirror_rules"
      SET "includeBotInboundFiles" = true, "updatedAt" = now()
      WHERE "enabled" = true
        AND "includeWebUploads" = true
        AND "includeBotInboundFiles" = false
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Data changes are intentionally not reverted: an administrator may have changed the rule after upgrade.
  }
}
