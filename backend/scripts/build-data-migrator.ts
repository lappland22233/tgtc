import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../src/database/database.config';
import { databaseEntities } from '../src/database/entities';

const BATCH_SIZE = Math.max(1, Number(process.env.MIGRATION_BATCH_SIZE || 500));
const sourceOptions = createDatabaseOptions({ ...process.env, DB_TYPE: 'postgres', DB_MIGRATIONS_RUN: 'false' });
const targetPath = resolve(process.env.MIGRATION_TARGET || process.env.DB_SQLITE_PATH || 'data/tgtc.sqlite');
const tempPath = `${targetPath}.migrating-${process.pid}`;
const diagnosticPath = `${targetPath}.failed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

function quote(name: string): string { return `"${name.replace(/"/g, '""')}"`; }
function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value;
  return value;
}

async function count(ds: DataSource, table: string): Promise<number> {
  const rows = await ds.query(`SELECT COUNT(*) AS count FROM ${quote(table)}`);
  return Number(rows[0]?.count || 0);
}

async function migrateTable(source: DataSource, target: DataSource, entity: Function): Promise<{ table: string; rows: number }> {
  const metadata = source.getMetadata(entity);
  const table = metadata.tableName;
  const columns = metadata.columns.map(c => c.databaseName);
  let offset = 0;
  let copied = 0;
  while (true) {
    const rows = await source.query(
      `SELECT ${columns.map(quote).join(', ')} FROM ${quote(table)} ORDER BY ${quote(metadata.primaryColumns[0].databaseName)} LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset],
    );
    if (!rows.length) break;
    for (const row of rows) {
      const values = columns.map(column => normalize(row[column]));
      const placeholders = values.map(() => '?').join(', ');
      await target.query(
        `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${placeholders})`,
        values,
      );
    }
    copied += rows.length;
    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return { table, rows: copied };
}

async function validate(target: DataSource, source: DataSource): Promise<Record<string, unknown>> {
  const tables: Record<string, unknown> = {};
  for (const entity of databaseEntities) {
    const table = source.getMetadata(entity).tableName;
    const sourceCount = await count(source, table);
    const targetCount = await count(target, table);
    if (sourceCount !== targetCount) throw new Error(`逐表行数校验失败: ${table}: source=${sourceCount}, target=${targetCount}`);
    tables[table] = { source: sourceCount, target: targetCount };
  }
  const foreignKeys = await target.query('PRAGMA foreign_key_check');
  if (foreignKeys.length) throw new Error(`外键校验失败: ${JSON.stringify(foreignKeys.slice(0, 20))}`);
  for (const entity of databaseEntities) {
    const metadata = target.getMetadata(entity);
    for (const unique of metadata.uniques) {
      const columns = unique.columns.map(c => typeof c === 'string' ? c : c.databaseName);
      if (!columns.length) continue;
      const duplicates = await target.query(`SELECT ${columns.map(quote).join(', ')}, COUNT(*) AS n FROM ${quote(metadata.tableName)} GROUP BY ${columns.map(quote).join(', ')} HAVING COUNT(*) > 1 LIMIT 1`);
      if (duplicates.length) throw new Error(`唯一约束校验失败: ${metadata.tableName}.${columns.join(',')}`);
    }
  }
  return { tables, foreignKeys: 0, uniqueConstraints: 'checked' };
}

async function main(): Promise<void> {
  if (existsSync(tempPath)) throw new Error(`已有迁移临时文件，拒绝覆盖: ${tempPath}`);
  mkdirSync(dirname(targetPath), { recursive: true });
  const source = new DataSource(sourceOptions);
  const target = new DataSource(createDatabaseOptions({ ...process.env, DB_TYPE: 'sqlite', DB_DATABASE: tempPath, DB_MIGRATIONS_RUN: 'true' }));
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), source: sourceOptions.database, target: targetPath, batchSize: BATCH_SIZE, tables: [] };
  try {
    await source.initialize();
    await target.initialize();
    await target.query('PRAGMA foreign_keys = OFF');
    for (const entity of databaseEntities) {
      const result = await migrateTable(source, target, entity);
      (report.tables as unknown[]).push(result);
    }
    await target.query('PRAGMA foreign_keys = ON');
    report.validation = await validate(target, source);
    report.completedAt = new Date().toISOString();
    writeFileSync(`${tempPath}.report.json`, JSON.stringify(report, null, 2));
    await target.destroy();
    await source.destroy();
    if (existsSync(targetPath)) renameSync(targetPath, `${targetPath}.backup-${Date.now()}`);
    renameSync(tempPath, targetPath);
    console.log(JSON.stringify({ ok: true, target: targetPath, report: `${tempPath}.report.json` }, null, 2));
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.failedAt = new Date().toISOString();
    writeFileSync(diagnosticPath, JSON.stringify(report, null, 2));
    try { await target.destroy(); } catch { /* preserve diagnosis */ }
    try { await source.destroy(); } catch { /* preserve diagnosis */ }
    console.error(`迁移失败，临时数据库已保留: ${tempPath}\n诊断报告: ${diagnosticPath}`);
    process.exitCode = 1;
  }
}

void main();
