import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PostgreSQL 只调整新建账号默认值。存量值无法区分管理员显式设置与旧默认值，故不做回填。
 * 回滚仅恢复列默认值；已创建账号上的配置属于业务数据，不由迁移 down 改写。
 */
export class SetTelegramAccountDefaultInflight1803900000000 implements MigrationInterface {
  name = 'SetTelegramAccountDefaultInflight1803900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`
      ALTER TABLE "telegram_accounts"
      ALTER COLUMN "maxInflight" SET DEFAULT 16
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`
      ALTER TABLE "telegram_accounts"
      ALTER COLUMN "maxInflight" SET DEFAULT 8
    `);
  }
}
