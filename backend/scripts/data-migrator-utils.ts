import { existsSync, renameSync } from 'fs';

export type FileRenameOperations = {
  exists: (path: string) => boolean;
  rename: (from: string, to: string) => void;
};

export type SqliteIndexShape = {
  name?: string;
  columns: string[];
  unique: boolean;
  where?: string;
  sql?: string;
};

export function normalizeSql(value: string | undefined): string {
  return (value || '')
    .replace(/["`\[\]]/g, '')
    .replace(/\bfalse\b/gi, '0')
    .replace(/\btrue\b/gi, '1')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 表达式索引不能只依赖 PRAGMA index_info；必要时按 sqlite_master.sql 比对。 */
export function sqliteIndexMatches(actual: SqliteIndexShape, expected: SqliteIndexShape): boolean {
  if (expected.name && actual.name !== expected.name) return false;
  if (actual.unique !== expected.unique) return false;
  if (normalizeSql(actual.where) !== normalizeSql(expected.where)) return false;
  if (expected.sql) return normalizeSql(actual.sql) === normalizeSql(expected.sql);
  return actual.columns.join('\0') === expected.columns.join('\0');
}

type SnapshotRunner = {
  connect: () => Promise<void>;
  startTransaction: (isolationLevel: 'REPEATABLE READ') => Promise<void>;
  query: (sql: string) => Promise<unknown>;
};

/** 在首个源端读取前建立 PostgreSQL 全迁移一致性只读快照。 */
export async function beginPostgresReadOnlySnapshot(runner: SnapshotRunner): Promise<void> {
  await runner.connect();
  await runner.startTransaction('REPEATABLE READ');
  await runner.query('SET TRANSACTION READ ONLY');
}

const defaultOperations: FileRenameOperations = {
  exists: existsSync,
  rename: renameSync,
};

/**
 * 用已完成校验的临时文件替换目标文件。
 * 若目标已先移动为备份、随后临时文件发布失败，则立即把备份恢复到原路径。
 */
export function publishMigratedFile(
  temporaryPath: string,
  targetPath: string,
  backupPath: string,
  operations: FileRenameOperations = defaultOperations,
): string | undefined {
  const hadTarget = operations.exists(targetPath);
  if (hadTarget) operations.rename(targetPath, backupPath);

  try {
    operations.rename(temporaryPath, targetPath);
    return hadTarget ? backupPath : undefined;
  } catch (publishError) {
    if (!hadTarget) throw publishError;
    try {
      operations.rename(backupPath, targetPath);
    } catch (restoreError) {
      throw new AggregateError(
        [publishError, restoreError],
        `发布迁移文件失败，且备份恢复失败；备份仍应位于 ${backupPath}`,
      );
    }
    throw publishError;
  }
}

/**
 * 报告先发布；随后数据库发布失败时恢复旧报告，报告发布失败时数据库保持不变。
 */
export function publishMigrationArtifacts(
  temporaryDatabasePath: string,
  databasePath: string,
  databaseBackupPath: string,
  temporaryReportPath: string,
  reportPath: string,
  reportBackupPath: string,
  operations: FileRenameOperations = defaultOperations,
): void {
  const reportBackup = publishMigratedFile(temporaryReportPath, reportPath, reportBackupPath, operations);
  try {
    publishMigratedFile(temporaryDatabasePath, databasePath, databaseBackupPath, operations);
  } catch (databaseError) {
    try {
      if (operations.exists(reportPath)) operations.rename(reportPath, temporaryReportPath);
      if (reportBackup) operations.rename(reportBackup, reportPath);
    } catch (reportRestoreError) {
      throw new AggregateError(
        [databaseError, reportRestoreError],
        `数据库发布失败，且报告恢复失败；旧报告备份仍应位于 ${reportBackupPath}`,
      );
    }
    throw databaseError;
  }
}
