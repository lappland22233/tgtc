import { MigrationInterface, QueryRunner } from 'typeorm';
import { sqliteMinuteMetricsTable } from '../database/sqlite-minute-metrics';

export class SqliteCreateMinuteMetrics1804600000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (runner.dataSource.options.type !== 'better-sqlite3') return;
    await runner.query(sqliteMinuteMetricsTable);
    // Earlier PG conversions emitted Date.toISOString(). SQLite compares these columns as text.
    const isoPattern = '????-??-??T??:??:??.???Z';
    const format = '%Y-%m-%d %H:%M:%f';
    await runner.query(`UPDATE "access_logs" SET "createdAt" = strftime(?, "createdAt")
      WHERE "createdAt" GLOB ? AND strftime(?, "createdAt") IS NOT NULL`, [format, isoPattern, format]);
    // Keep the native row when a later aggregation already wrote the same minute under its canonical key.
    await runner.query(`DELETE FROM "access_log_metrics_1min" AS legacy WHERE legacy."windowTime" GLOB ?
      AND EXISTS (SELECT 1 FROM "access_log_metrics_1min" AS canonical
        WHERE canonical."windowTime" = strftime(?, legacy."windowTime"))`, [isoPattern, format]);
    await runner.query(`UPDATE "access_log_metrics_1min" SET "windowTime" = strftime(?, "windowTime")
      WHERE "windowTime" GLOB ? AND strftime(?, "windowTime") IS NOT NULL`, [format, isoPattern, format]);
  }

  async down(): Promise<void> {
    // Converted databases already used this table before this migration. Preserve their history.
  }
}
