import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SQLite 无法直接修改既有列默认值；应用层会为新建账号提供 maxInflight=16。
 * 存量值无法区分旧默认与管理员显式设置，因此此迁移不回填、不改写任何账号行。
 */
export class SqliteSetTelegramAccountDefaultInflight1803900000000 implements MigrationInterface {
  name = 'SqliteSetTelegramAccountDefaultInflight1803900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    await queryRunner.query('PRAGMA table_info("telegram_accounts")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    // 应用层默认值及账号数据不由此迁移管理；无可安全逆转的 schema 变更。
  }
}
