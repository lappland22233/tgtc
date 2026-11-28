import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `share_preview_sessions` 增加 `hitCount`（SQLite 方言）。
 * 列语义与 PostgreSQL 版本一致；SQLite 不支持统一 DROP COLUMN 回滚，down 为空操作。
 */
export class SqliteAddSharePreviewSessionHitCount1805000000000 implements MigrationInterface {
  name = 'SqliteAddSharePreviewSessionHitCount1805000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'better-sqlite3') return;

    const table = await queryRunner.getTable('share_preview_sessions');
    if (table && !table.columns.some((c) => c.name === 'hitCount')) {
      await queryRunner.query(
        'ALTER TABLE "share_preview_sessions" ADD COLUMN "hitCount" integer NOT NULL DEFAULT 0',
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'better-sqlite3') return;
  }
}