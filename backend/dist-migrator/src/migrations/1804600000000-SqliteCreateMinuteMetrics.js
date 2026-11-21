"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteCreateMinuteMetrics1804600000000 = void 0;
const sqlite_minute_metrics_1 = require("../database/sqlite-minute-metrics");
class SqliteCreateMinuteMetrics1804600000000 {
    async up(runner) {
        if (runner.connection.options.type !== 'sqlite')
            return;
        await runner.query(sqlite_minute_metrics_1.sqliteMinuteMetricsTable);
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
    async down() {
        // Converted databases already used this table before this migration. Preserve their history.
    }
}
exports.SqliteCreateMinuteMetrics1804600000000 = SqliteCreateMinuteMetrics1804600000000;
