import 'dotenv/config';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { DataSource, DataSourceOptions, EntityMetadata, QueryRunner } from 'typeorm';
import { SqliteEntitySchema1700000000000 } from '../src/migrations/0000000000000-SqliteEntitySchema';
import { SqliteSchemaAlignment1800000000000 } from '../src/migrations/1800000000000-SqliteSchemaAlignment';
import { beginPostgresReadOnlySnapshot, publishMigrationArtifacts, sqliteIndexMatches } from './data-migrator-utils';

type DatabaseModules = {
  createDatabaseOptions: (env?: NodeJS.ProcessEnv) => DataSourceOptions;
  databaseEntities: readonly Function[];
};
type QueryExecutor = { query: (sql: string, parameters?: unknown[]) => Promise<any> };

type ColumnShape = EntityMetadata['columns'][number] & { isUnique?: boolean };
type MigrationMode = 'single-key' | 'composite-key' | 'empty-no-key';
type TablePlan = {
  table: string;
  columns: string[];
  primaryColumns: string[];
  sourceMetadata?: EntityMetadata;
  targetMetadata?: EntityMetadata;
};
type TableSnapshot = {
  table: string;
  mode: MigrationMode;
  primaryColumns: string[];
  maxPrimaryKey: unknown[] | null;
  sourceCount: number;
  copied: number;
  targetCount?: number;
};
type SqliteColumnInfo = { name: string; type: string; notnull: number; pk: number };
type SqliteIndexInfo = { name: string; unique: number; partial: number };
type ExpectedIndex = { name?: string; columns: string[]; unique: boolean; where?: string; sql?: string };
type ExpectedForeignKey = { columns: string[]; referencedTable: string; referencedColumns: string[]; onDelete?: string };
type SchemaExpectation = {
  table: string;
  columns: Array<{ name: string; type?: string; nullable?: boolean }>;
  primaryColumns: string[];
  foreignKeys: ExpectedForeignKey[];
  indexes: ExpectedIndex[];
};

type MigrationReport = {
  summary: Record<string, unknown>;
  migration: { tables: TableSnapshot[] };
  validation: {
    schema?: Record<string, unknown>;
    data?: Record<string, unknown>;
    integrity?: Record<string, unknown>;
  };
  error?: { message: string; stack?: string };
};

function loadDatabaseModules(type: 'postgres' | 'sqlite'): DatabaseModules {
  process.env.DB_TYPE = type;
  for (const file of Object.keys(require.cache)) {
    if (file.includes(`${require('path').sep}common${require('path').sep}entities${require('path').sep}`)
      || /[\\/]database[\\/](database-types|database\.config|entities|uuid\.subscriber)\.(ts|js)$/.test(file)) {
      delete require.cache[file];
    }
  }
  const config = require('../src/database/database.config') as { createDatabaseOptions: DatabaseModules['createDatabaseOptions'] };
  const entities = require('../src/database/entities') as { databaseEntities: readonly Function[] };
  return { createDatabaseOptions: config.createDatabaseOptions, databaseEntities: entities.databaseEntities };
}

const BATCH_SIZE = positiveInt(process.env.MIGRATION_BATCH_SIZE, 2000);
const SQLITE_PARAMETER_LIMIT = positiveInt(process.env.MIGRATION_SQLITE_PARAMETER_LIMIT, 900);
const sourceModules = loadDatabaseModules('postgres');
const sourceOptions = sourceModules.createDatabaseOptions({ ...process.env, DB_TYPE: 'postgres', DB_MIGRATIONS_RUN: 'false' });
const targetPath = resolve(process.env.MIGRATION_TARGET || process.env.DB_SQLITE_PATH || 'data/tgtc.sqlite');
const tempPath = `${targetPath}.migrating-${process.pid}`;
const reportPath = `${targetPath}.migration-report.json`;
const diagnosticPath = `${targetPath}.failed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function quote(name: string): string { return `"${name.replace(/"/g, '""')}"`; }
function sqliteAffinity(type: string): string {
  const normalized = type.toUpperCase();
  if (normalized.includes('INT')) return 'INTEGER';
  if (normalized.includes('CHAR') || normalized.includes('CLOB') || normalized.includes('TEXT')) return 'TEXT';
  if (normalized.includes('BLOB') || !normalized) return 'BLOB';
  if (normalized.includes('REAL') || normalized.includes('FLOA') || normalized.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}
function expectedAffinity(type: unknown): string {
  if (type === Number || type === 'bigint' || type === 'integer' || type === 'int') return 'INTEGER';
  // SQLite 基线/增量迁移将布尔列声明为 boolean；按 SQLite 类型亲和性规则，
  // BOOLEAN 属于 NUMERIC，而不是 INTEGER。值仍由 convertValue 规范化为 0/1。
  if (type === Boolean || type === 'boolean') return 'NUMERIC';
  if (type === Buffer || type === 'blob') return 'BLOB';
  if (type === Date || type === 'timestamp' || type === 'timestamptz' || type === 'datetime') return 'NUMERIC';
  return 'TEXT';
}
function isSimpleJson(column: ColumnShape): boolean {
  return column.type === 'simple-json' || column.type === 'jsonb' || column.type === 'json';
}
function isDateColumn(column: ColumnShape): boolean {
  return column.type === Date || ['timestamp', 'timestamptz', 'datetime', 'date'].includes(String(column.type));
}
function convertValue(value: unknown, sourceColumn?: ColumnShape, targetColumn?: ColumnShape): unknown {
  if (value === null || value === undefined || Buffer.isBuffer(value)) return value;
  const column = targetColumn || sourceColumn;
  if (!column) return value instanceof Date ? value.toISOString() : value;
  if (isSimpleJson(column)) {
    if (typeof value === 'string') {
      try { return JSON.stringify(JSON.parse(value)); } catch { throw new Error(`simple-json 值不是合法 JSON: ${column.entityMetadata.tableName}.${column.databaseName}`); }
    }
    return JSON.stringify(value);
  }
  if (column.type === Boolean || column.type === 'boolean') {
    if (value === true || value === 1 || value === '1' || value === 'true' || value === 't') return 1;
    if (value === false || value === 0 || value === '0' || value === 'false' || value === 'f') return 0;
    throw new Error(`boolean 值无法转换: ${column.entityMetadata.tableName}.${column.databaseName}=${String(value)}`);
  }
  if (isDateColumn(column)) {
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) throw new Error(`datetime 值无法转换: ${column.entityMetadata.tableName}.${column.databaseName}`);
    return date.toISOString();
  }
  if (column.type === 'bigint') {
    const text = String(value);
    if (!/^-?\d+$/.test(text)) throw new Error(`bigint 值不是整数: ${column.entityMetadata.tableName}.${column.databaseName}`);
    const numeric = Number(text);
    if (!Number.isSafeInteger(numeric)) {
      throw new Error(`bigint 超出 SQLite Node 驱动安全整数范围，拒绝静默损失精度: ${column.entityMetadata.tableName}.${column.databaseName}=${text}`);
    }
    return numeric;
  }
  return value instanceof Date ? value.toISOString() : value;
}

async function tableExists(ds: DataSource, table: string): Promise<boolean> {
  const rows = await ds.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", [table]);
  return rows.length > 0;
}
async function postgresTableExists(source: QueryExecutor, table: string): Promise<boolean> {
  const rows = await source.query('SELECT to_regclass($1) AS table_name', [table]);
  return rows[0]?.table_name !== null;
}
async function count(source: QueryExecutor, table: string): Promise<number> {
  const rows = await source.query(`SELECT COUNT(*) AS count FROM ${quote(table)}`);
  return Number(rows[0]?.count || 0);
}
function keysetPredicate(primaryColumns: readonly string[], operator: '>' | '<=', start: number): string {
  return `(${primaryColumns.map(quote).join(', ')}) ${operator} (${primaryColumns.map((_, index) => `$${start + index}`).join(', ')})`;
}

async function buildPlans(source: DataSource, sourceSnapshot: QueryExecutor, target: DataSource): Promise<TablePlan[]> {
  const plans: TablePlan[] = sourceModules.databaseEntities.map((entity) => {
    const sourceMetadata = source.getMetadata(entity);
    const targetMetadata = target.getMetadata(sourceMetadata.targetName);
    return {
      table: sourceMetadata.tableName,
      columns: sourceMetadata.columns.map((column) => column.databaseName),
      primaryColumns: sourceMetadata.primaryColumns.map((column) => column.databaseName),
      sourceMetadata,
      targetMetadata,
    };
  });
  const nonEntityPlans: TablePlan[] = [
    { table: 'file_tags', columns: ['fileId', 'tagId'], primaryColumns: ['fileId', 'tagId'] },
    { table: 'folder_closure', columns: ['id_ancestor', 'id_descendant'], primaryColumns: ['id_ancestor', 'id_descendant'] },
  ];
  for (const plan of nonEntityPlans) {
    if (await postgresTableExists(sourceSnapshot, plan.table)) plans.push(plan);
  }
  return plans;
}

async function migrateTable(source: QueryExecutor, target: DataSource, plan: TablePlan): Promise<TableSnapshot> {
  const { table, columns, primaryColumns } = plan;
  const sourceCount = await count(source, table);
  if (!primaryColumns.length) {
    if (sourceCount > 0) throw new Error(`表 ${table} 无主键且包含 ${sourceCount} 行；无法提供稳定 keyset 快照，拒绝隐式 OFFSET 迁移`);
    return { table, mode: 'empty-no-key', primaryColumns: [], maxPrimaryKey: null, sourceCount, copied: 0 };
  }
  const maxRows = sourceCount === 0 ? [] : await source.query(
    `SELECT ${primaryColumns.map(quote).join(', ')} FROM ${quote(table)} ORDER BY ${primaryColumns.map((column) => `${quote(column)} DESC`).join(', ')} LIMIT 1`,
  );
  const maxPrimaryKey = maxRows.length ? primaryColumns.map((column) => maxRows[0][column]) : null;
  let lastPrimaryKey: unknown[] | undefined;
  let copied = 0;
  while (maxPrimaryKey) {
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (lastPrimaryKey) {
      conditions.push(keysetPredicate(primaryColumns, '>', parameters.length + 1));
      parameters.push(...lastPrimaryKey);
    }
    conditions.push(keysetPredicate(primaryColumns, '<=', parameters.length + 1));
    parameters.push(...maxPrimaryKey, BATCH_SIZE);
    const rows = await source.query(
      `SELECT ${columns.map(quote).join(', ')} FROM ${quote(table)} WHERE ${conditions.join(' AND ')} ORDER BY ${primaryColumns.map(quote).join(', ')} LIMIT $${parameters.length}`,
      parameters,
    );
    if (!rows.length) break;
    const rowsPerInsert = Math.max(1, Math.floor(SQLITE_PARAMETER_LIMIT / columns.length));
    for (let start = 0; start < rows.length; start += rowsPerInsert) {
      const chunk = rows.slice(start, start + rowsPerInsert);
      const values = chunk.flatMap((row) => columns.map((column) => {
        const sourceColumn = plan.sourceMetadata?.columns.find((item) => item.databaseName === column);
        const targetColumn = plan.targetMetadata?.columns.find((item) => item.databaseName === column);
        return convertValue(row[column], sourceColumn, targetColumn);
      }));
      const placeholders = chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
      await target.query(`INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES ${placeholders}`, values);
    }
    copied += rows.length;
    lastPrimaryKey = primaryColumns.map((column) => rows[rows.length - 1][column]);
    if (rows.length < BATCH_SIZE) break;
  }
  return {
    table,
    mode: primaryColumns.length === 1 ? 'single-key' : 'composite-key',
    primaryColumns,
    maxPrimaryKey,
    sourceCount,
    copied,
  };
}

function metadataExpectation(metadata: EntityMetadata): SchemaExpectation {
  const indexes: ExpectedIndex[] = metadata.indices
    .filter((index) => index.synchronize !== false && index.columns.length > 0)
    .map((index) => ({
      name: index.name,
      columns: index.columns.map((column) => typeof column === 'string' ? column : column.databaseName),
      unique: index.isUnique,
      where: index.where,
      sql: metadata.tableName === 'folders' && index.name === 'uq_folders_owner_parent_name_active'
        ? `CREATE UNIQUE INDEX "uq_folders_owner_parent_name_active" ON "folders" ("ownerId", COALESCE("parentId", ''), "name") WHERE "isDeleted" = false`
        : undefined,
    }));
  for (const unique of metadata.uniques) {
    const columns = unique.columns.map((column) => typeof column === 'string' ? column : column.databaseName);
    // SQLite 将表级 UNIQUE 约束实现为 sqlite_autoindex_*，名称不保留；按列与唯一性匹配。
    if (columns.length) indexes.push({ columns, unique: true });
  }
  for (const column of (metadata.columns as ColumnShape[]).filter((item) => item.isUnique)) {
    indexes.push({ columns: [column.databaseName], unique: true });
  }
  return {
    table: metadata.tableName,
    columns: metadata.columns.map((column) => ({ name: column.databaseName, type: expectedAffinity(column.type), nullable: column.isNullable })),
    primaryColumns: metadata.primaryColumns.map((column) => column.databaseName),
    foreignKeys: metadata.foreignKeys.map((foreignKey) => ({
      columns: foreignKey.columns.map((column) => column.databaseName),
      referencedTable: foreignKey.referencedEntityMetadata.tableName,
      referencedColumns: foreignKey.referencedColumns.map((column) => column.databaseName),
      onDelete: foreignKey.onDelete,
    })),
    indexes,
  };
}

function nonEntityExpectations(): SchemaExpectation[] {
  return [
    {
      table: 'file_tags',
      columns: [{ name: 'fileId', type: 'TEXT', nullable: false }, { name: 'tagId', type: 'TEXT', nullable: false }],
      primaryColumns: ['fileId', 'tagId'],
      foreignKeys: [
        { columns: ['fileId'], referencedTable: 'files', referencedColumns: ['id'], onDelete: 'CASCADE' },
        { columns: ['tagId'], referencedTable: 'tags', referencedColumns: ['id'], onDelete: 'CASCADE' },
      ],
      indexes: [
        { name: 'idx_file_tags_tagId', columns: ['tagId'], unique: false },
        { name: 'idx_file_tags_fileId', columns: ['fileId'], unique: false },
      ],
    },
    {
      table: 'folder_closure',
      columns: [{ name: 'id_ancestor', type: 'TEXT', nullable: false }, { name: 'id_descendant', type: 'TEXT', nullable: false }],
      primaryColumns: ['id_ancestor', 'id_descendant'],
      foreignKeys: [
        { columns: ['id_ancestor'], referencedTable: 'folders', referencedColumns: ['id'], onDelete: 'CASCADE' },
        { columns: ['id_descendant'], referencedTable: 'folders', referencedColumns: ['id'], onDelete: 'CASCADE' },
      ],
      indexes: [{ name: 'IDX_closure_descendant', columns: ['id_descendant'], unique: false }],
    },
  ];
}

async function ensureNonEntityTables(target: DataSource, plans: readonly TablePlan[]): Promise<void> {
  if (plans.some((plan) => plan.table === 'file_tags')) {
    await target.query(`CREATE TABLE IF NOT EXISTS "file_tags" (
      "fileId" varchar NOT NULL,
      "tagId" varchar NOT NULL,
      PRIMARY KEY ("fileId", "tagId"),
      FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE,
      FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE
    )`);
    await target.query('CREATE INDEX IF NOT EXISTS "idx_file_tags_tagId" ON "file_tags" ("tagId")');
    await target.query('CREATE INDEX IF NOT EXISTS "idx_file_tags_fileId" ON "file_tags" ("fileId")');
  }
  if (plans.some((plan) => plan.table === 'folder_closure')) {
    await target.query(`CREATE TABLE IF NOT EXISTS "folder_closure" (
      "id_ancestor" varchar NOT NULL,
      "id_descendant" varchar NOT NULL,
      PRIMARY KEY ("id_ancestor", "id_descendant"),
      FOREIGN KEY ("id_ancestor") REFERENCES "folders"("id") ON DELETE CASCADE,
      FOREIGN KEY ("id_descendant") REFERENCES "folders"("id") ON DELETE CASCADE
    )`);
    await target.query('CREATE INDEX IF NOT EXISTS "IDX_closure_descendant" ON "folder_closure" ("id_descendant")');
  }
}

async function readIndex(target: DataSource, table: string, index: SqliteIndexInfo): Promise<ExpectedIndex> {
  const columns = await target.query(`PRAGMA index_info(${quote(index.name)})`) as Array<{ seqno: number; name: string }>;
  const sqlRows = await target.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", [index.name]);
  const sql = String(sqlRows[0]?.sql || '');
  const whereMatch = sql.match(/\bWHERE\s+(.+)$/i);
  return {
    name: index.name,
    columns: columns.sort((a, b) => a.seqno - b.seqno).map((column) => column.name).filter(Boolean),
    unique: index.unique === 1,
    where: index.partial === 1 ? whereMatch?.[1] || '' : undefined,
    sql,
  };
}

async function validateSchema(target: DataSource, expectations: readonly SchemaExpectation[]): Promise<Record<string, unknown>> {
  const tables: Record<string, unknown> = {};
  for (const expected of expectations) {
    if (!(await tableExists(target, expected.table))) throw new Error(`schema/table 校验失败: 缺少表 ${expected.table}`);
    const columns = await target.query(`PRAGMA table_info(${quote(expected.table)})`) as SqliteColumnInfo[];
    const actualPrimary = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    if (actualPrimary.join('\0') !== expected.primaryColumns.join('\0')) {
      throw new Error(`schema/主键校验失败: ${expected.table}: expected=${expected.primaryColumns.join(',')}, actual=${actualPrimary.join(',')}`);
    }
    for (const expectedColumn of expected.columns) {
      const actual = columns.find((column) => column.name === expectedColumn.name);
      if (!actual) throw new Error(`schema/列校验失败: ${expected.table}.${expectedColumn.name} 缺失`);
      if (expectedColumn.type && sqliteAffinity(actual.type) !== expectedColumn.type) {
        throw new Error(`schema/列类型校验失败: ${expected.table}.${expectedColumn.name}: expected=${expectedColumn.type}, actual=${actual.type}`);
      }
      const actualNullable = actual.notnull === 0 && actual.pk === 0;
      if (expectedColumn.nullable !== undefined && actualNullable !== expectedColumn.nullable) {
        throw new Error(`schema/列可空性校验失败: ${expected.table}.${expectedColumn.name}`);
      }
    }
    const foreignKeys = await target.query(`PRAGMA foreign_key_list(${quote(expected.table)})`) as Array<{ id: number; seq: number; table: string; from: string; to: string; on_delete: string }>;
    for (const expectedForeignKey of expected.foreignKeys) {
      const grouped = foreignKeys.filter((foreignKey) => foreignKey.table === expectedForeignKey.referencedTable)
        .sort((a, b) => a.seq - b.seq);
      const found = expectedForeignKey.columns.every((column, index) => grouped[index]?.from === column
        && grouped[index]?.to === expectedForeignKey.referencedColumns[index])
        && (!expectedForeignKey.onDelete || grouped[0]?.on_delete.toUpperCase() === expectedForeignKey.onDelete.toUpperCase());
      if (!found) throw new Error(`schema/外键校验失败: ${expected.table}(${expectedForeignKey.columns.join(',')})`);
    }
    const indexRows = await target.query(`PRAGMA index_list(${quote(expected.table)})`) as SqliteIndexInfo[];
    const actualIndexes = await Promise.all(indexRows.map((index) => readIndex(target, expected.table, index)));
    for (const expectedIndex of expected.indexes) {
      const found = actualIndexes.some((actual) => sqliteIndexMatches(actual, expectedIndex));
      if (!found) {
        throw new Error(`schema/索引校验失败: ${expected.table}.${expectedIndex.name || expectedIndex.columns.join('_')}（含 unique/partial 条件）`);
      }
    }
    tables[expected.table] = {
      columns: columns.length,
      primaryColumns: actualPrimary,
      foreignKeys: foreignKeys.length,
      indexes: actualIndexes.map((index) => ({ name: index.name, unique: index.unique, partial: Boolean(index.where) })),
    };
  }
  return { status: 'passed', tables };
}

async function validateData(target: DataSource, snapshots: TableSnapshot[]): Promise<Record<string, unknown>> {
  const tables: Record<string, unknown> = {};
  for (const snapshot of snapshots) {
    const targetCount = await count(target, snapshot.table);
    snapshot.targetCount = targetCount;
    if (targetCount !== snapshot.copied || snapshot.copied !== snapshot.sourceCount) {
      throw new Error(`data/计数校验失败: ${snapshot.table}: snapshot=${snapshot.sourceCount}, copied=${snapshot.copied}, target=${targetCount}`);
    }
    tables[snapshot.table] = { source: snapshot.sourceCount, copied: snapshot.copied, target: targetCount, mode: snapshot.mode };
  }
  return { status: 'passed', tables };
}

async function validateIntegrity(target: DataSource): Promise<Record<string, unknown>> {
  const foreignKeys = await target.query('PRAGMA foreign_key_check');
  if (foreignKeys.length) throw new Error(`integrity/外键校验失败: ${JSON.stringify(foreignKeys.slice(0, 20))}`);
  const integrityRows = await target.query('PRAGMA integrity_check');
  const messages = integrityRows.flatMap((row: Record<string, unknown>) => Object.values(row).map(String));
  if (messages.length !== 1 || messages[0].toLowerCase() !== 'ok') {
    throw new Error(`integrity_check 失败: ${messages.slice(0, 20).join('; ')}`);
  }
  return { status: 'passed', integrityCheck: 'ok', foreignKeyViolations: 0 };
}

async function main(): Promise<void> {
  if (existsSync(tempPath)) throw new Error(`已有迁移临时文件，拒绝覆盖: ${tempPath}`);
  mkdirSync(dirname(targetPath), { recursive: true });
  const source = new DataSource(sourceOptions);
  const targetModules = loadDatabaseModules('sqlite');
  const targetOptions = targetModules.createDatabaseOptions({ ...process.env, DB_TYPE: 'sqlite', DB_DATABASE: tempPath, DB_MIGRATIONS_RUN: 'true' });
  if (targetOptions.type !== 'sqlite') throw new Error('迁移目标配置必须为 SQLite');
  const target = new DataSource({
    ...targetOptions,
    database: tempPath,
    migrationsRun: true,
    migrations: [SqliteEntitySchema1700000000000, SqliteSchemaAlignment1800000000000],
  });
  const report: MigrationReport = {
    summary: {
      status: 'running',
      startedAt: new Date().toISOString(),
      source: String((sourceOptions as { database?: unknown }).database || ''),
      target: targetPath,
      temporaryTarget: tempPath,
      batchSize: BATCH_SIZE,
      sqliteParameterLimit: SQLITE_PARAMETER_LIMIT,
      schemaMigrations: ['SqliteEntitySchema1700000000000', 'SqliteSchemaAlignment1800000000000'],
    },
    migration: { tables: [] },
    validation: {},
  };
  let transactionStarted = false;
  let sourceSnapshot: QueryRunner | undefined;
  let sourceTransactionStarted = false;
  try {
    await source.initialize();
    sourceSnapshot = source.createQueryRunner();
    await beginPostgresReadOnlySnapshot(sourceSnapshot);
    sourceTransactionStarted = true;
    await target.initialize();
    const plans = await buildPlans(source, sourceSnapshot, target);
    await ensureNonEntityTables(target, plans);
    const expectations = [
      ...targetModules.databaseEntities.map((entity) => metadataExpectation(target.getMetadata(entity))),
      ...nonEntityExpectations().filter((expectation) => plans.some((plan) => plan.table === expectation.table)),
    ];
    report.validation.schema = await validateSchema(target, expectations);
    await target.query('PRAGMA foreign_keys = OFF');
    await target.query('PRAGMA synchronous = OFF');
    await target.query('PRAGMA journal_mode = MEMORY');
    await target.query('BEGIN TRANSACTION');
    transactionStarted = true;
    for (const plan of plans) report.migration.tables.push(await migrateTable(sourceSnapshot, target, plan));
    await target.query('COMMIT');
    transactionStarted = false;
    await target.query('PRAGMA synchronous = NORMAL');
    await target.query('PRAGMA journal_mode = DELETE');
    await target.query('PRAGMA foreign_keys = ON');
    report.validation.data = await validateData(target, report.migration.tables);
    report.validation.integrity = await validateIntegrity(target);
    report.summary.status = 'passed';
    report.summary.completedAt = new Date().toISOString();
    report.summary.tableCount = report.migration.tables.length;
    report.summary.rowCount = report.migration.tables.reduce((sum, table) => sum + table.copied, 0);
    writeFileSync(`${tempPath}.report.json`, JSON.stringify(report, null, 2));
    await sourceSnapshot.commitTransaction();
    sourceTransactionStarted = false;
    await sourceSnapshot.release();
    sourceSnapshot = undefined;
    await target.destroy();
    await source.destroy();
    const publicationId = Date.now();
    const backupPath = `${targetPath}.backup-${publicationId}`;
    const reportBackupPath = `${reportPath}.backup-${publicationId}`;
    publishMigrationArtifacts(
      tempPath,
      targetPath,
      backupPath,
      `${tempPath}.report.json`,
      reportPath,
      reportBackupPath,
    );
    console.log(JSON.stringify({ ok: true, target: targetPath, report: reportPath }, null, 2));
  } catch (error) {
    if (transactionStarted) {
      try { await target.query('ROLLBACK'); } catch { /* transaction may already be closed */ }
    }
    if (sourceSnapshot) {
      if (sourceTransactionStarted || sourceSnapshot.isTransactionActive) {
        try { await sourceSnapshot.rollbackTransaction(); } catch { /* preserve original migration error */ }
      }
      try { await sourceSnapshot.release(); } catch { /* preserve original migration error */ }
      sourceSnapshot = undefined;
      sourceTransactionStarted = false;
    }
    report.summary.status = 'failed';
    report.summary.failedAt = new Date().toISOString();
    report.error = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
    writeFileSync(diagnosticPath, JSON.stringify(report, null, 2));
    try { if (target.isInitialized) await target.destroy(); } catch { /* preserve diagnosis */ }
    try { if (source.isInitialized) await source.destroy(); } catch { /* preserve diagnosis */ }
    console.error(`迁移失败，临时数据库已保留: ${tempPath}\n诊断报告: ${diagnosticPath}`);
    process.exitCode = 1;
  }
}

void main();
