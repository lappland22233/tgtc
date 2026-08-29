import { ColumnType, QueryRunner } from 'typeorm';

export type DatabaseType = 'postgres' | 'sqlite';

/** 从同一份配置解析数据库类型，避免各调用点对 process.env 的不一致判断。 */
export function getDatabaseType(env: NodeJS.ProcessEnv = process.env): DatabaseType {
  const value = (env.DB_TYPE || 'postgres').trim().toLowerCase();
  if (value !== 'postgres' && value !== 'sqlite') {
    throw new Error(`DB_TYPE 必须是 postgres 或 sqlite，当前值: ${value}`);
  }
  return value;
}

/** 根据当前驱动选择 TypeORM 可识别且语义接近的列类型；未设置时保持 PostgreSQL 类型。 */
export function databaseColumnType(postgresType: ColumnType, env: NodeJS.ProcessEnv = process.env): ColumnType {
  if (getDatabaseType(env) !== 'sqlite') return postgresType;
  if (postgresType === 'uuid' || postgresType === 'enum') return 'varchar';
  if (postgresType === 'jsonb') return 'simple-json';
  if (postgresType === 'timestamptz' || postgresType === 'timestamp') return 'datetime';
  return postgresType;
}

/** 可安全用于 TypeORM default 的当前时间表达式。 */
export function databaseCurrentTimestamp(env: NodeJS.ProcessEnv = process.env): string {
  return getDatabaseType(env) === 'sqlite' ? 'CURRENT_TIMESTAMP' : 'NOW()';
}

/** SQL 聚合/数值类型转换：SQLite 使用原生动态类型，PostgreSQL 保留显式 cast。 */
export function databaseCast(expression: string, cast: 'int' | 'bigint' | 'numeric', env: NodeJS.ProcessEnv = process.env): string {
  return getDatabaseType(env) === 'sqlite' ? expression : `${expression}::${cast}`;
}

/** 按时间桶聚合的跨方言表达式。返回值保持可分组、可排序的时间字符串。 */
export function databaseDateBucket(column: string, unit: 'minute' | 'hour' | 'day', env: NodeJS.ProcessEnv = process.env): string {
  if (getDatabaseType(env) === 'postgres') return `DATE_TRUNC('${unit}', ${column})`;
  const format = unit === 'minute' ? '%Y-%m-%d %H:%M:00' : unit === 'hour' ? '%Y-%m-%d %H:00:00' : '%Y-%m-%d 00:00:00';
  return `strftime('${format}', ${column})`;
}

/** 行锁仅在 PostgreSQL 可用；SQLite 写事务本身已串行化。 */
export function databaseForUpdate(dataSourceType: string, lock: 'update' | 'key-share' = 'update'): string {
  if (dataSourceType !== 'postgres') return '';
  return lock === 'key-share' ? ' FOR KEY SHARE' : ' FOR UPDATE';
}

/** 将 PostgreSQL $n 占位符转换为 SQLite 编号占位符 ?n，保留重复参数的索引语义。 */
export function databaseQueryText(sql: string, type: DatabaseType): string {
  if (type !== 'sqlite') return sql;
  return sql.replace(/\$(\d+)/g, '?$1');
}

function isSqliteBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database is locked|database is busy/i.test(message);
}

/** 统一识别 PostgreSQL 与 SQLite 的唯一约束冲突。 */
export function isDatabaseUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; driverError?: { code?: string } } | null;
  const code = candidate?.code ?? candidate?.driverError?.code;
  return code === '23505' || code === 'SQLITE_CONSTRAINT' || code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/** SQLite 写锁冲突的有限退避；PostgreSQL 路径完全不改变。 */
export async function databaseQuery<T = unknown>(
  runner: QueryRunner | { query: (sql: string, parameters?: unknown[]) => Promise<T> },
  sql: string,
  parameters: unknown[] = [],
  type: DatabaseType,
  retries = 2,
): Promise<T> {
  const attempts = type === 'sqlite' ? Math.max(0, retries) + 1 : 1;
  const queryText = databaseQueryText(sql, type);
  // sqlite3 裸查询不接受 Date 对象；统一转为与 TypeORM datetime 持久化格式可比较的 UTC 文本。
  // PostgreSQL 继续接收原始 Date，由 pg 驱动按 timestamptz/timestamp 语义编码。
  const queryParameters = type === 'sqlite'
    ? parameters.map((value) => value instanceof Date ? sqliteDateParameter(value) : value)
    : parameters;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      // TypeORM sqlite3 对 INSERT/UPDATE ... RETURNING 使用 run()，会丢弃返回行；
      // 直接调用 sqlite3 all() 才能取得原子 UPSERT 的 RETURNING 结果。
      if (type === 'sqlite' && /\bRETURNING\b/i.test(queryText)) {
        const holder = runner as unknown as {
          connection?: { driver?: { databaseConnection?: SqliteAllConnection } };
          driver?: { databaseConnection?: SqliteAllConnection };
        };
        const connection = holder.connection?.driver?.databaseConnection ?? holder.driver?.databaseConnection;
        if (connection?.all) {
          return await sqliteAll<T>(connection, queryText, queryParameters);
        }
      }
      return await runner.query(queryText, queryParameters);
    } catch (error) {
      if (type !== 'sqlite' || !isSqliteBusy(error) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw new Error('数据库查询未执行');
}

type SqliteAllConnection = {
  all: (sql: string, parameters: unknown[], callback: (error: Error | null, rows: unknown[]) => void) => void;
};

function sqliteDateParameter(value: Date): string {
  return value.toISOString().replace('T', ' ').replace('Z', '');
}

function sqliteAll<T>(connection: SqliteAllConnection, sql: string, parameters: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    connection.all(sql, parameters, (error, rows) => {
      if (error) reject(error);
      else resolve(rows as T);
    });
  });
}
