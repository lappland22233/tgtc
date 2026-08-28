import { DataSourceOptions } from 'typeorm';
import { join } from 'path';
import { databaseEntities } from './entities';
import { UuidSubscriber } from './uuid.subscriber';

export type DatabaseType = 'postgres' | 'sqlite';

/**
 * SQLite 与 PostgreSQL 的统一配置工厂。
 * 默认仍为 PostgreSQL；迁移是正式 schema 生命周期，synchronize 永远关闭。
 */
export function createDatabaseOptions(env: NodeJS.ProcessEnv = process.env): DataSourceOptions {
  const type = (env.DB_TYPE || 'postgres').toLowerCase() as DatabaseType;
  if (type !== 'postgres' && type !== 'sqlite') {
    throw new Error(`DB_TYPE 必须是 postgres 或 sqlite，当前值: ${type}`);
  }

  const migrations = [join(__dirname, '..', 'migrations', '*{.ts,.js}')];
  if (type === 'sqlite') {
    // PG 历史迁移包含 CREATE EXTENSION、ILIKE 等 SQLite 不支持的方言；SQLite 使用独立基线。
    const sqliteMigrations = [join(__dirname, '..', 'migrations', '0000000000000-SqliteEntitySchema*{.ts,.js}')];
    return {
      type: 'sqlite',
      database: env.DB_DATABASE || 'data/tgtc.sqlite',
      entities: [...databaseEntities],
      subscribers: [UuidSubscriber],
      migrations: sqliteMigrations,
      synchronize: false,
      migrationsRun: env.DB_MIGRATIONS_RUN === 'true',
      logging: env.NODE_ENV === 'development',
      busyTimeout: Number(env.DB_SQLITE_BUSY_TIMEOUT_MS || 5000),
    };
  }

  return {
    type: 'postgres',
    host: env.DB_HOST || 'localhost',
    port: Number(env.DB_PORT || 5432),
    username: env.DB_USERNAME || 'postgres',
    password: env.DB_PASSWORD || undefined,
    database: env.DB_DATABASE || 'test',
    entities: [...databaseEntities],
    migrations,
    synchronize: false,
    migrationsRun: env.DB_MIGRATIONS_RUN === 'true',
    logging: env.NODE_ENV === 'development',
    maxQueryExecutionTime: 5000,
    extra: {
      max: Number(env.DB_POOL_SIZE || 20),
      connectionTimeoutMillis: Number(env.DB_CONNECTION_TIMEOUT_MS || 5000),
      statement_timeout: Number(env.DB_STATEMENT_TIMEOUT_MS || 30000),
      query_timeout: Number(env.DB_QUERY_TIMEOUT_MS || 35000),
      lock_timeout: Number(env.DB_LOCK_TIMEOUT_MS || 3000),
      idle_in_transaction_session_timeout: Number(env.DB_IDLE_TRANSACTION_TIMEOUT_MS || 30000),
      ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
    },
  };
}
