import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `files` 增加 `overwriteSnapshot`（SQLite 方言）。
 * 列语义与 PostgreSQL 版本一致；SQLite 不支持统一 DROP COLUMN 回滚，down 为空操作。
 */
export class SqliteAddFileOverwriteSnapshot1805100000000 implements MigrationInterface {
  name = 'SqliteAddFileOverwriteSnapshot1805100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'better-sqlite3') return;

    const table = await queryRunner.getTable('files');
    if (table && !table.columns.some((c) => c.name === 'overwriteSnapshot')) {
      await queryRunner.query('ALTER TABLE "files" ADD COLUMN "overwriteSnapshot" text');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'better-sqlite3') return;
  }
}