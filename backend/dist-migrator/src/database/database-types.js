"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDatabaseType = getDatabaseType;
exports.databaseColumnType = databaseColumnType;
exports.databaseCurrentTimestamp = databaseCurrentTimestamp;
exports.databaseCast = databaseCast;
exports.databaseDateBucket = databaseDateBucket;
exports.databaseForUpdate = databaseForUpdate;
exports.databasePessimisticWriteLock = databasePessimisticWriteLock;
exports.isSqliteBusy = isSqliteBusy;
exports.isDatabaseUniqueViolation = isDatabaseUniqueViolation;
exports.databaseRawQuery = databaseRawQuery;
exports.databaseQuery = databaseQuery;
exports.sqliteDateParameter = sqliteDateParameter;
/** 从同一份配置解析数据库类型，避免各调用点对 process.env 的不一致判断。 */
function getDatabaseType(env = process.env) {
    const value = (env.DB_TYPE || 'postgres').trim().toLowerCase();
    if (value !== 'postgres' && value !== 'sqlite') {
        throw new Error(`DB_TYPE 必须是 postgres 或 sqlite，当前值: ${value}`);
    }
    return value;
}
/** 根据当前驱动选择 TypeORM 可识别且语义接近的列类型；未设置时保持 PostgreSQL 类型。 */
function databaseColumnType(postgresType, env = process.env) {
    if (getDatabaseType(env) !== 'sqlite')
        return postgresType;
    if (postgresType === 'uuid' || postgresType === 'enum')
        return 'varchar';
    if (postgresType === 'jsonb')
        return 'simple-json';
    if (postgresType === 'timestamptz' || postgresType === 'timestamp')
        return 'datetime';
    return postgresType;
}
/** 可安全用于 TypeORM default 的当前时间表达式。 */
function databaseCurrentTimestamp(env = process.env) {
    return getDatabaseType(env) === 'sqlite' ? 'CURRENT_TIMESTAMP' : 'NOW()';
}
/** SQL 聚合/数值类型转换：SQLite 使用原生动态类型，PostgreSQL 保留显式 cast。 */
function databaseCast(expression, cast, env = process.env) {
    return getDatabaseType(env) === 'sqlite' ? expression : `${expression}::${cast}`;
}
/** 按时间桶聚合的跨方言表达式。返回值保持可分组、可排序的时间字符串。 */
function databaseDateBucket(column, unit, env = process.env) {
    if (getDatabaseType(env) === 'postgres')
        return `DATE_TRUNC('${unit}', ${column})`;
    const format = unit === 'minute' ? '%Y-%m-%d %H:%M:00' : unit === 'hour' ? '%Y-%m-%d %H:00:00' : '%Y-%m-%d 00:00:00';
    return `strftime('${format}', ${column})`;
}
/** 行锁仅在 PostgreSQL 可用；SQLite 写事务本身已串行化。 */
function databaseForUpdate(dataSourceType, lock = 'update') {
    if (dataSourceType !== 'postgres')
        return '';
    return lock === 'key-share' ? ' FOR KEY SHARE' : ' FOR UPDATE';
}
/**
 * TypeORM `findOne` 的行锁选项：**仅 PostgreSQL 可用**。
 *
 * 为什么必须按方言省略：SQLite 驱动不支持行锁，传入 `pessimistic_write` 会直接抛
 * `LockNotSupportedOnGivenDriverError`——这不是「少一层保护」，而是整条路径 500
 * （覆盖上传、删除/恢复等）。SQLite 的写事务本身已串行化，省略该选项即语义等价。
 *
 * 用法：`repo.findOne({ where, ...databasePessimisticWriteLock() })`。
 */
function databasePessimisticWriteLock(env = process.env) {
    return getDatabaseType(env) === 'postgres' ? { lock: { mode: 'pessimistic_write' } } : {};
}
function isSqliteBusy(error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error?.code;
    return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database is locked|database is busy/i.test(message);
}
/** 统一识别 PostgreSQL 与 SQLite 的唯一约束冲突。 */
function isDatabaseUniqueViolation(error) {
    const candidate = error;
    const code = candidate?.code ?? candidate?.driverError?.code;
    return code === '23505' || code === 'SQLITE_CONSTRAINT' || code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}
/** Preserve the driver's raw result shape while binding cross-dialect SQL parameters. */
function databaseRawQuery(runner, sql, parameters, type = getDatabaseType()) {
    // better-sqlite3 binds positional ? parameters in appearance order. Expand
    // repeated or reordered PostgreSQL $n references without changing their values.
    let queryText = sql;
    let queryParameters = parameters;
    if (type === 'sqlite') {
        queryParameters = parameters.map(value => value instanceof Date ? sqliteDateParameter(value) : value);
        const positional = [];
        queryText = sql.replace(/\$(\d+)/g, (_, index) => {
            positional.push(queryParameters[Number(index) - 1]);
            return '?';
        });
        if (positional.length)
            queryParameters = positional;
    }
    return runner.query(queryText, queryParameters);
}
/** SQLite 写锁冲突的有限退避；PostgreSQL 路径完全不改变。 */
async function databaseQuery(runner, sql, parameters = [], type, retries = 2) {
    const attempts = type === 'sqlite' ? Math.max(0, retries) + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return normalizePostgresQueryResult(await databaseRawQuery(runner, sql, parameters, type), type);
        }
        catch (error) {
            if (type !== 'sqlite' || !isSqliteBusy(error) || attempt === attempts - 1)
                throw error;
            await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
    }
    throw new Error('数据库查询未执行');
}
/**
 * PostgreSQL 归一化：TypeORM 的 `PostgresQueryRunner.query()` 对 `UPDATE`/`DELETE`
 * 返回 `[rows, affectedCount]` 元组——
 *
 * ```js
 * switch (raw.command) {
 *   case "DELETE":
 *   case "UPDATE":
 *     // for UPDATE and DELETE query additionally return number of affected rows
 *     result.raw = [raw.rows, raw.rowCount];
 * ```
 *
 * 而 `SELECT`/`INSERT ... RETURNING` 返回纯 rows 数组。若不解包，调用方拿到的
 * `rows.length` 对 UPDATE 恒为 2（0 行时形如 `[[], 0]`），使所有「按行数判断
 * 是否命中 / 是否达上限」的逻辑静默失效：已实际导致 Bot 每日配额永不生效
 * （`rows.length > 0` 恒真）、告警一键确认只处理首批且数量错报为 2。
 * SQLite 驱动原生返回 RETURNING 行集。
 *
 * 判定条件（PG 行集只可能是对象数组，故无歧义）：
 * 长度恰为 2、首元素是数组、次元素是数字。据此不会误伤「恰好返回 2 行」的 SELECT。
 */
function normalizePostgresQueryResult(result, type) {
    if (type !== 'postgres')
        return result;
    if (!Array.isArray(result) || result.length !== 2)
        return result;
    const [rows, affected] = result;
    if (Array.isArray(rows) && typeof affected === 'number') {
        return rows;
    }
    return result;
}
function sqliteDateParameter(value) {
    return value.toISOString().replace('T', ' ').replace('Z', '');
}
