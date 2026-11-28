import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `files` 增加 `detectedExtension`（SQLite 方言）。
 * 列语义与 PostgreSQL 版本一致；SQLite 不支持统一 DROP COLUMN 回滚，down 为空操作。
 */
export class SqliteAddFileDetectedExtension1805200000000 implements MigrationInterface {
  name = 'SqliteAddFileDetectedExtension1805200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'better-sqlite3') return;

    const table = await queryRunner.getTable('files');
    if (table && !table.columns.some((c) => c.name === 'detectedExtension')) {
      await queryRunner.query('ALTER TABLE "files" ADD COLUMN "detectedExtension" varchar(16)');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'better-sqlite3') return;
  }
}