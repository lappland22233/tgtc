"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NON_ENTITY_TABLE_DEFINITIONS = void 0;
exports.sqliteForeignKeyMatches = sqliteForeignKeyMatches;
exports.normalizeSql = normalizeSql;
exports.sqliteIndexMatches = sqliteIndexMatches;
exports.beginPostgresReadOnlySnapshot = beginPostgresReadOnlySnapshot;
exports.publishMigratedFile = publishMigratedFile;
exports.publishMigrationArtifacts = publishMigrationArtifacts;
const fs_1 = require("fs");
/**
 * 无 TypeORM 实体的运行时表必须在同一处声明迁移计划、SQLite DDL 与校验契约，
 * 避免新增表时只补其中一个环节而产生可启动但 jobs 缺表的数据库。
 */
exports.NON_ENTITY_TABLE_DEFINITIONS = [
    {
        table: 'file_tags',
        columns: [
            { name: 'fileId', type: 'TEXT', nullable: false },
            { name: 'tagId', type: 'TEXT', nullable: false },
        ],
        primaryColumns: ['fileId', 'tagId'],
        foreignKeys: [
            { columns: ['fileId'], referencedTable: 'files', referencedColumns: ['id'], onDelete: 'CASCADE' },
            { columns: ['tagId'], referencedTable: 'tags', referencedColumns: ['id'], onDelete: 'CASCADE' },
        ],
        indexes: [
            { name: 'idx_file_tags_tagId', columns: ['tagId'], unique: false },
            { name: 'idx_file_tags_fileId', columns: ['fileId'], unique: false },
        ],
        createSql: `CREATE TABLE IF NOT EXISTS "file_tags" (
      "fileId" varchar NOT NULL,
      "tagId" varchar NOT NULL,
      PRIMARY KEY ("fileId", "tagId"),
      FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE,
      FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE
    )`,
        indexSql: [
            'CREATE INDEX IF NOT EXISTS "idx_file_tags_tagId" ON "file_tags" ("tagId")',
            'CREATE INDEX IF NOT EXISTS "idx_file_tags_fileId" ON "file_tags" ("fileId")',
        ],
    },
    {
        table: 'folder_closure',
        columns: [
            { name: 'id_ancestor', type: 'TEXT', nullable: false },
            { name: 'id_descendant', type: 'TEXT', nullable: false },
        ],
        primaryColumns: ['id_ancestor', 'id_descendant'],
        foreignKeys: [
            { columns: ['id_ancestor'], referencedTable: 'folders', referencedColumns: ['id'], onDelete: 'CASCADE' },
            { columns: ['id_descendant'], referencedTable: 'folders', referencedColumns: ['id'], onDelete: 'CASCADE' },
        ],
        indexes: [{ name: 'IDX_closure_descendant', columns: ['id_descendant'], unique: false }],
        createSql: `CREATE TABLE IF NOT EXISTS "folder_closure" (
      "id_ancestor" varchar NOT NULL,
      "id_descendant" varchar NOT NULL,
      PRIMARY KEY ("id_ancestor", "id_descendant"),
      FOREIGN KEY ("id_ancestor") REFERENCES "folders"("id") ON DELETE CASCADE,
      FOREIGN KEY ("id_descendant") REFERENCES "folders"("id") ON DELETE CASCADE
    )`,
        indexSql: ['CREATE INDEX IF NOT EXISTS "IDX_closure_descendant" ON "folder_closure" ("id_descendant")'],
    },
    {
        table: 'access_log_metrics_1min',
        columns: [
            { name: 'windowTime', type: 'NUMERIC', nullable: false },
            { name: 'totalRequests', type: 'INTEGER', nullable: false },
            { name: 'qpsAvg', type: 'REAL', nullable: false },
            { name: 'error5xxCount', type: 'INTEGER', nullable: false },
            { name: 'error4xxCount', type: 'INTEGER', nullable: false },
            { name: 'totalBandwidth', type: 'INTEGER', nullable: false },
            { name: 'p95Duration', type: 'REAL', nullable: false },
            { name: 'uniqueIps', type: 'INTEGER', nullable: false },
        ],
        primaryColumns: ['windowTime'],
        foreignKeys: [],
        indexes: [],
        createSql: `CREATE TABLE IF NOT EXISTS "access_log_metrics_1min" (
      "windowTime" datetime NOT NULL PRIMARY KEY,
      "totalRequests" integer NOT NULL DEFAULT 0,
      "qpsAvg" real NOT NULL DEFAULT 0,
      "error5xxCount" integer NOT NULL DEFAULT 0,
      "error4xxCount" integer NOT NULL DEFAULT 0,
      "totalBandwidth" bigint NOT NULL DEFAULT 0,
      "p95Duration" real NOT NULL DEFAULT 0,
      "uniqueIps" integer NOT NULL DEFAULT 0
    )`,
        indexSql: [],
    },
    {
        table: 'baseline_stats',
        columns: [
            { name: 'id', type: 'TEXT', nullable: false },
            { name: 'metricName', type: 'TEXT', nullable: false },
            { name: 'hourBucket', type: 'INTEGER', nullable: false },
            { name: 'dayOfWeek', type: 'INTEGER', nullable: false },
            { name: 'mean', type: 'REAL', nullable: false },
            { name: 'stddev', type: 'REAL', nullable: false },
            { name: 'sampleCount', type: 'INTEGER', nullable: false },
            { name: 'updatedAt', type: 'NUMERIC', nullable: true },
        ],
        primaryColumns: ['id'],
        foreignKeys: [],
        indexes: [{ columns: ['metricName', 'hourBucket', 'dayOfWeek'], unique: true }],
        createSql: `CREATE TABLE IF NOT EXISTS "baseline_stats" (
      "id" varchar NOT NULL PRIMARY KEY DEFAULT (
        lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
        substr(lower(hex(randomblob(2))), 2) || '-' ||
        substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
        lower(hex(randomblob(6)))
      ),
      "metricName" varchar(100) NOT NULL,
      "hourBucket" integer NOT NULL,
      "dayOfWeek" integer NOT NULL,
      "mean" real NOT NULL DEFAULT 0,
      "stddev" real NOT NULL DEFAULT 0,
      "sampleCount" integer NOT NULL DEFAULT 0,
      "updatedAt" datetime DEFAULT CURRENT_TIMESTAMP,
      UNIQUE ("metricName", "hourBucket", "dayOfWeek")
    )`,
        indexSql: [],
    },
    {
        table: 'daily_active_users',
        columns: [
            { name: 'date', type: 'NUMERIC', nullable: false },
            { name: 'dauCount', type: 'INTEGER', nullable: false },
            { name: 'dauIps', type: 'INTEGER', nullable: false },
            { name: 'newUsers', type: 'INTEGER', nullable: false },
            { name: 'createdAt', type: 'NUMERIC', nullable: true },
        ],
        primaryColumns: ['date'],
        foreignKeys: [],
        indexes: [],
        createSql: `CREATE TABLE IF NOT EXISTS "daily_active_users" (
      "date" date NOT NULL PRIMARY KEY,
      "dauCount" integer NOT NULL DEFAULT 0,
      "dauIps" integer NOT NULL DEFAULT 0,
      "newUsers" integer NOT NULL DEFAULT 0,
      "createdAt" datetime DEFAULT CURRENT_TIMESTAMP
    )`,
        indexSql: [],
    },
];
/** SQLite 用 id 区分独立外键、用 seq 表示复合外键列顺序。 */
function sqliteForeignKeyMatches(actualRows, expected) {
    const groups = new Map();
    for (const row of actualRows) {
        const group = groups.get(row.id) || [];
        group.push(row);
        groups.set(row.id, group);
    }
    return [...groups.values()].some((group) => {
        const rows = [...group].sort((left, right) => left.seq - right.seq);
        return rows.length === expected.columns.length
            && rows.every((row, index) => row.table === expected.referencedTable
                && row.from === expected.columns[index]
                && row.to === expected.referencedColumns[index]
                && (!expected.onDelete || row.on_delete.toUpperCase() === expected.onDelete.toUpperCase()));
    });
}
function normalizeSql(value) {
    return (value || '')
        .replace(/["`\[\]]/g, '')
        .replace(/\bfalse\b/gi, '0')
        .replace(/\btrue\b/gi, '1')
        .replace(/\s+/g, '')
        .toLowerCase();
}
/** 表达式索引不能只依赖 PRAGMA index_info；必要时按 sqlite_master.sql 比对。 */
function sqliteIndexMatches(actual, expected) {
    if (expected.name && actual.name !== expected.name)
        return false;
    if (actual.unique !== expected.unique)
        return false;
    if (normalizeSql(actual.where) !== normalizeSql(expected.where))
        return false;
    if (expected.sql)
        return normalizeSql(actual.sql) === normalizeSql(expected.sql);
    return actual.columns.join('\0') === expected.columns.join('\0');
}
/** 在首个源端读取前建立 PostgreSQL 全迁移一致性只读快照。 */
async function beginPostgresReadOnlySnapshot(runner) {
    await runner.connect();
    await runner.startTransaction('REPEATABLE READ');
    await runner.query('SET TRANSACTION READ ONLY');
}
const defaultOperations = {
    exists: fs_1.existsSync,
    rename: fs_1.renameSync,
};
/**
 * 用已完成校验的临时文件替换目标文件。
 * 若目标已先移动为备份、随后临时文件发布失败，则立即把备份恢复到原路径。
 */
function publishMigratedFile(temporaryPath, targetPath, backupPath, operations = defaultOperations) {
    const hadTarget = operations.exists(targetPath);
    if (hadTarget)
        operations.rename(targetPath, backupPath);
    try {
        operations.rename(temporaryPath, targetPath);
        return hadTarget ? backupPath : undefined;
    }
    catch (publishError) {
        if (!hadTarget)
            throw publishError;
        try {
            operations.rename(backupPath, targetPath);
        }
        catch (restoreError) {
            throw new AggregateError([publishError, restoreError], `发布迁移文件失败，且备份恢复失败；备份仍应位于 ${backupPath}`);
        }
        throw publishError;
    }
}
/**
 * 报告先发布；随后数据库发布失败时恢复旧报告，报告发布失败时数据库保持不变。
 */
function publishMigrationArtifacts(temporaryDatabasePath, databasePath, databaseBackupPath, temporaryReportPath, reportPath, reportBackupPath, operations = defaultOperations) {
    const reportBackup = publishMigratedFile(temporaryReportPath, reportPath, reportBackupPath, operations);
    try {
        publishMigratedFile(temporaryDatabasePath, databasePath, databaseBackupPath, operations);
    }
    catch (databaseError) {
        try {
            if (operations.exists(reportPath))
                operations.rename(reportPath, temporaryReportPath);
            if (reportBackup)
                operations.rename(reportBackup, reportPath);
        }
        catch (reportRestoreError) {
            throw new AggregateError([databaseError, reportRestoreError], `数据库发布失败，且报告恢复失败；旧报告备份仍应位于 ${reportBackupPath}`);
        }
        throw databaseError;
    }
}
