"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sqliteMinuteMetricsTable = void 0;
exports.sqliteMinuteMetricsTable = `CREATE TABLE IF NOT EXISTS "access_log_metrics_1min" (
      "windowTime" datetime NOT NULL PRIMARY KEY,
      "totalRequests" integer NOT NULL DEFAULT 0,
      "qpsAvg" real NOT NULL DEFAULT 0,
      "error5xxCount" integer NOT NULL DEFAULT 0,
      "error4xxCount" integer NOT NULL DEFAULT 0,
      "totalBandwidth" bigint NOT NULL DEFAULT 0,
      "p95Duration" real NOT NULL DEFAULT 0,
      "uniqueIps" integer NOT NULL DEFAULT 0
    )`;
