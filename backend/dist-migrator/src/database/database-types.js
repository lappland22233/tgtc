"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.databaseColumnType = databaseColumnType;
exports.databaseCurrentTimestamp = databaseCurrentTimestamp;
exports.databaseForUpdate = databaseForUpdate;
/** 根据当前驱动选择 TypeORM 可识别且语义接近的列类型；未设置时保持 PostgreSQL 类型。 */
function databaseColumnType(postgresType) {
    if ((process.env.DB_TYPE || 'postgres').toLowerCase() !== 'sqlite')
        return postgresType;
    if (postgresType === 'uuid')
        return 'varchar';
    if (postgresType === 'enum')
        return 'varchar';
    if (postgresType === 'jsonb')
        return 'simple-json';
    if (postgresType === 'timestamptz' || postgresType === 'timestamp')
        return 'datetime';
    return postgresType;
}
/** 可安全用于 TypeORM default 的当前时间表达式。 */
function databaseCurrentTimestamp() {
    return (process.env.DB_TYPE || 'postgres').toLowerCase() === 'sqlite'
        ? 'CURRENT_TIMESTAMP'
        : 'NOW()';
}
/** 行锁仅在 PostgreSQL 可用；SQLite 写事务本身已串行化。 */
function databaseForUpdate(dataSourceType) {
    return dataSourceType === 'postgres' ? ' FOR UPDATE' : '';
}
