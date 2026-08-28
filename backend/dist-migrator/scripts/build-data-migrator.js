"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fs_1 = require("fs");
const path_1 = require("path");
const typeorm_1 = require("typeorm");
const database_config_1 = require("../src/database/database.config");
const entities_1 = require("../src/database/entities");
const BATCH_SIZE = Math.max(1, Number(process.env.MIGRATION_BATCH_SIZE || 500));
const sourceOptions = (0, database_config_1.createDatabaseOptions)({ ...process.env, DB_TYPE: 'postgres', DB_MIGRATIONS_RUN: 'false' });
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
async function migrateTable(source, target, entity) {
    const metadata = source.getMetadata(entity);
    const table = metadata.tableName;
    const columns = metadata.columns.map(c => c.databaseName);
    let offset = 0;
    let copied = 0;
    while (true) {
        const rows = await source.query(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(table)} ORDER BY ${quote(metadata.primaryColumns[0].databaseName)} LIMIT $1 OFFSET $2`, [BATCH_SIZE, offset]);
        if (!rows.length)
            break;
        for (const row of rows) {
            const values = columns.map(column => normalize(row[column]));
            const placeholders = values.map(() => '?').join(', ');
            await target.query(`INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${placeholders})`, values);
        }
        copied += rows.length;
        offset += rows.length;
        if (rows.length < BATCH_SIZE)
            break;
    }
    return { table, rows: copied };
}
async function validate(target, source) {
    const tables = {};
    for (const entity of entities_1.databaseEntities) {
        const table = source.getMetadata(entity).tableName;
        const sourceCount = await count(source, table);
        const targetCount = await count(target, table);
        if (sourceCount !== targetCount)
            throw new Error(`逐表行数校验失败: ${table}: source=${sourceCount}, target=${targetCount}`);
        tables[table] = { source: sourceCount, target: targetCount };
    }
    const foreignKeys = await target.query('PRAGMA foreign_key_check');
    if (foreignKeys.length)
        throw new Error(`外键校验失败: ${JSON.stringify(foreignKeys.slice(0, 20))}`);
    for (const entity of entities_1.databaseEntities) {
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
    const target = new typeorm_1.DataSource((0, database_config_1.createDatabaseOptions)({ ...process.env, DB_TYPE: 'sqlite', DB_DATABASE: tempPath, DB_MIGRATIONS_RUN: 'true' }));
    const report = { startedAt: new Date().toISOString(), source: sourceOptions.database, target: targetPath, batchSize: BATCH_SIZE, tables: [] };
    try {
        await source.initialize();
        await target.initialize();
        await target.query('PRAGMA foreign_keys = OFF');
        for (const entity of entities_1.databaseEntities) {
            const result = await migrateTable(source, target, entity);
            report.tables.push(result);
        }
        await target.query('PRAGMA foreign_keys = ON');
        report.validation = await validate(target, source);
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
