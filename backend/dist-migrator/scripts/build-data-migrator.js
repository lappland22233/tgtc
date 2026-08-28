"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fs_1 = require("fs");
const path_1 = require("path");
const typeorm_1 = require("typeorm");
const _0000000000000_SqliteEntitySchema_1 = require("../src/migrations/0000000000000-SqliteEntitySchema");
function loadDatabaseModules(type) {
    process.env.DB_TYPE = type;
    for (const file of Object.keys(require.cache)) {
        if (file.includes(`${require('path').sep}common${require('path').sep}entities${require('path').sep}`)
            || /[\\/]database[\\/](database-types|database\.config|entities|uuid\.subscriber)\.(ts|js)$/.test(file)) {
            delete require.cache[file];
        }
    }
    const config = require('../src/database/database.config');
    const entities = require('../src/database/entities');
    return { createDatabaseOptions: config.createDatabaseOptions, databaseEntities: entities.databaseEntities };
}
const BATCH_SIZE = Math.max(1, Number(process.env.MIGRATION_BATCH_SIZE || 2000));
const SQLITE_PARAMETER_LIMIT = Math.max(1, Number(process.env.MIGRATION_SQLITE_PARAMETER_LIMIT || 900));
const sourceModules = loadDatabaseModules('postgres');
const sourceOptions = sourceModules.createDatabaseOptions({ ...process.env, DB_TYPE: 'postgres', DB_MIGRATIONS_RUN: 'false' });
const targetPath = (0, path_1.resolve)(process.env.MIGRATION_TARGET || process.env.DB_SQLITE_PATH || 'data/tgtc.sqlite');
const tempPath = `${targetPath}.migrating-${process.pid}`;
const diagnosticPath = `${targetPath}.failed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
function quote(name) { return `"${name.replace(/"/g, '""')}"`; }
function normalize(value) {
    if (value instanceof Date)
        return value.toISOString();
    if (Buffer.isBuffer(value))
        return value;
    return value;
}
async function count(ds, table) {
    const rows = await ds.query(`SELECT COUNT(*) AS count FROM ${quote(table)}`);
    return Number(rows[0]?.count || 0);
}
async function migrateTable(source, target, sourceEntity) {
    const metadata = source.getMetadata(sourceEntity);
    const table = metadata.tableName;
    const columns = metadata.columns.map(c => c.databaseName);
    const primaryColumn = metadata.primaryColumns[0].databaseName;
    const snapshotRows = await source.query(`SELECT COUNT(*) AS count, (SELECT ${quote(primaryColumn)} FROM ${quote(table)} ORDER BY ${quote(primaryColumn)} DESC LIMIT 1) AS max_key FROM ${quote(table)}`);
    const sourceCount = Number(snapshotRows[0]?.count || 0);
    const maxPrimaryKey = snapshotRows[0]?.max_key;
    let lastPrimaryKey;
    let copied = 0;
    while (true) {
        const conditions = [];
        const parameters = [];
        if (lastPrimaryKey !== undefined) {
            conditions.push(`${quote(primaryColumn)} > $${parameters.length + 1}`);
            parameters.push(lastPrimaryKey);
        }
        if (maxPrimaryKey !== null && maxPrimaryKey !== undefined) {
            conditions.push(`${quote(primaryColumn)} <= $${parameters.length + 1}`);
            parameters.push(maxPrimaryKey);
        }
        parameters.push(BATCH_SIZE);
        const rows = await source.query(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(table)}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY ${quote(primaryColumn)} LIMIT $${parameters.length}`, parameters);
        if (!rows.length)
            break;
        const columnSql = columns.map(quote).join(', ');
        const rowsPerInsert = Math.max(1, Math.floor(SQLITE_PARAMETER_LIMIT / columns.length));
        for (let start = 0; start < rows.length; start += rowsPerInsert) {
            const chunk = rows.slice(start, start + rowsPerInsert);
            const values = chunk.flatMap(row => columns.map(column => normalize(row[column])));
            const placeholders = chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
            await target.query(`INSERT INTO ${quote(table)} (${columnSql}) VALUES ${placeholders}`, values);
        }
        copied += rows.length;
        lastPrimaryKey = rows[rows.length - 1][primaryColumn];
        if (rows.length < BATCH_SIZE)
            break;
    }
    return { table, primaryColumn, maxPrimaryKey, sourceCount, copied };
}
async function validate(target, snapshots, targetEntities) {
    const tables = {};
    for (const snapshot of snapshots) {
        const targetCount = snapshot.maxPrimaryKey === null || snapshot.maxPrimaryKey === undefined
            ? 0
            : await count(target, snapshot.table);
        if (targetCount !== snapshot.copied || snapshot.copied !== snapshot.sourceCount) {
            throw new Error(`迁移快照校验失败: ${snapshot.table}: snapshot=${snapshot.sourceCount}, copied=${snapshot.copied}, target=${targetCount}`);
        }
        tables[snapshot.table] = { snapshot: snapshot.sourceCount, copied: snapshot.copied, target: targetCount, maxPrimaryKey: snapshot.maxPrimaryKey };
    }
    const foreignKeys = await target.query('PRAGMA foreign_key_check');
    if (foreignKeys.length)
        throw new Error(`外键校验失败: ${JSON.stringify(foreignKeys.slice(0, 20))}`);
    for (const entity of targetEntities) {
        const metadata = target.getMetadata(entity);
        for (const unique of metadata.uniques) {
            const columns = unique.columns.map(c => typeof c === 'string' ? c : c.databaseName);
            if (!columns.length)
                continue;
            const duplicates = await target.query(`SELECT ${columns.map(quote).join(', ')}, COUNT(*) AS n FROM ${quote(metadata.tableName)} GROUP BY ${columns.map(quote).join(', ')} HAVING COUNT(*) > 1 LIMIT 1`);
            if (duplicates.length)
                throw new Error(`唯一约束校验失败: ${metadata.tableName}.${columns.join(',')}`);
        }
    }
    return { tables, foreignKeys: 0, uniqueConstraints: 'checked' };
}
async function main() {
    if ((0, fs_1.existsSync)(tempPath))
        throw new Error(`已有迁移临时文件，拒绝覆盖: ${tempPath}`);
    (0, fs_1.mkdirSync)((0, path_1.dirname)(targetPath), { recursive: true });
    const source = new typeorm_1.DataSource(sourceOptions);
    const targetModules = loadDatabaseModules('sqlite');
    const targetOptions = targetModules.createDatabaseOptions({ ...process.env, DB_TYPE: 'sqlite', DB_DATABASE: tempPath, DB_MIGRATIONS_RUN: 'true' });
    const target = new typeorm_1.DataSource({ ...targetOptions, migrations: [_0000000000000_SqliteEntitySchema_1.SqliteEntitySchema1700000000000] });
    const report = { startedAt: new Date().toISOString(), source: String(sourceOptions.database || ''), target: targetPath, batchSize: BATCH_SIZE, tables: [] };
    try {
        await source.initialize();
        await target.initialize();
        await target.query('PRAGMA foreign_keys = OFF');
        await target.query('PRAGMA synchronous = OFF');
        await target.query('PRAGMA journal_mode = MEMORY');
        await target.query('BEGIN TRANSACTION');
        const snapshots = [];
        for (const entity of sourceModules.databaseEntities) {
            const result = await migrateTable(source, target, entity);
            snapshots.push(result);
            report.tables.push(result);
        }
        await target.query('COMMIT');
        await target.query('PRAGMA synchronous = NORMAL');
        await target.query('PRAGMA journal_mode = DELETE');
        await target.query('PRAGMA foreign_keys = ON');
        report.validation = await validate(target, snapshots, targetModules.databaseEntities);
        report.completedAt = new Date().toISOString();
        (0, fs_1.writeFileSync)(`${tempPath}.report.json`, JSON.stringify(report, null, 2));
        await target.destroy();
        await source.destroy();
        if ((0, fs_1.existsSync)(targetPath))
            (0, fs_1.renameSync)(targetPath, `${targetPath}.backup-${Date.now()}`);
        (0, fs_1.renameSync)(tempPath, targetPath);
        console.log(JSON.stringify({ ok: true, target: targetPath, report: `${tempPath}.report.json` }, null, 2));
    }
    catch (error) {
        try {
            await target.query('ROLLBACK');
        }
        catch { /* transaction may not have started or already committed */ }
        report.error = error instanceof Error ? error.message : String(error);
        report.failedAt = new Date().toISOString();
        (0, fs_1.writeFileSync)(diagnosticPath, JSON.stringify(report, null, 2));
        try {
            await target.destroy();
        }
        catch { /* preserve diagnosis */ }
        try {
            await source.destroy();
        }
        catch { /* preserve diagnosis */ }
        console.error(`迁移失败，临时数据库已保留: ${tempPath}\n诊断报告: ${diagnosticPath}`);
        process.exitCode = 1;
    }
}
void main();
