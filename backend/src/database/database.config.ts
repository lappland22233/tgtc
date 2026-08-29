import { DataSourceOptions } from 'typeorm';
import { join } from 'path';
import { databaseEntities } from './entities';
import { UuidSubscriber } from './uuid.subscriber';
import { getDatabaseType } from './database-types';

export type DatabaseType = 'postgres' | 'sqlite';

/**
 * SQLite 与 PostgreSQL 的统一配置工厂。
 * 默认仍为 PostgreSQL；迁移是正式 schema 生命周期，synchronize 永远关闭。
 */
function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = Number(env[key] ?? fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function createDatabaseOptions(env: NodeJS.ProcessEnv = process.env): DataSourceOptions {
  const type = getDatabaseType(env);

  const migrations = [join(__dirname, '..', 'migrations', '*{.ts,.js}')];
  if (type === 'sqlite') {
    // PG 历史迁移包含 CREATE EXTENSION、ILIKE 等 SQLite 不支持的方言；SQLite 只加载
    // SQLite 基线及 SQLite 专用增量迁移，避免误执行 PostgreSQL 历史迁移。
    const sqliteMigrations = [join(__dirname, '..', 'migrations', '*-Sqlite*{.ts,.js}')];
    return {
      type: 'sqlite',
      database: env.DB_DATABASE || 'data/tgtc.sqlite',
      entities: [...databaseEntities],
      subscribers: [UuidSubscriber],
      migrations: sqliteMigrations,
      synchronize: false,
      migrationsRun: env.DB_MIGRATIONS_RUN === 'true',
      logging: env.NODE_ENV === 'development',
      busyTimeout: positiveInt(env, 'DB_SQLITE_BUSY_TIMEOUT_MS', 5000),
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
