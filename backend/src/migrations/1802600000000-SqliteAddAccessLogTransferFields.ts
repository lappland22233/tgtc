import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * access_logs 传输结果字段（SQLite 方言）。
 *
 * 全新库由 SQLite 基线按实体元数据建表，这里对存量库幂等补齐。
 * 沿用 Telegram Bot 直链迁移的 `getTable` 判定方式（SQLite 不支持
 * `ADD COLUMN IF NOT EXISTS`）。
 */
export class SqliteAddAccessLogTransferFields1802600000000 implements MigrationInterface {
  name = 'SqliteAddAccessLogTransferFields1802600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;

    const table = await queryRunner.getTable('access_logs');
    if (!table) return;

    const additions: Array<{ name: string; definition: string }> = [
      { name: 'transferCompleted', definition: 'boolean' },
      { name: 'transferAborted', definition: 'boolean' },
      { name: 'ranged', definition: 'boolean' },
      { name: 'terminationReason', definition: 'varchar(24)' },
      { name: 'responseBodyBytes', definition: 'bigint' },
    ];

    for (const column of additions) {
      if (table.columns.some((existing) => existing.name === column.name)) continue;
      await queryRunner.query(
        `ALTER TABLE "access_logs" ADD COLUMN "${column.name}" ${column.definition}`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    // SQLite 旧版本不支持 DROP COLUMN；保留列无数据风险，与既有迁移保持一致。
  }
}
