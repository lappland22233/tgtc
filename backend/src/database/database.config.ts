import { DataSourceOptions } from 'typeorm';
import { join } from 'path';
import { databaseEntities } from './entities';
import { UuidSubscriber } from './uuid.subscriber';
import { getDatabaseType } from './database-types';

export type DatabaseType = 'postgres' | 'sqlite';

/**
 * TypeORM 迁移 glob。只匹配以数字时间戳开头的正式迁移文件：
 * - 排除 *.spec.ts / *.test.ts 等测试文件，避免 CLI（无 Jest 全局）在 require 时
 *   抛出 "describe is not defined"（CI 空库迁移 smoke test 曾因此失败）。
 * - 同时覆盖 ts-node 源码执行（.ts）与构建产物执行（.js）两条链路。
 * - migration:create / migration:generate 产物名均为 "时间戳-名称.ts"，天然匹配。
 */
export function getMigrationPatterns(type: DatabaseType): string[] {
  if (type === 'sqlite') {
    // PG 历史迁移包含 CREATE EXTENSION、ILIKE 等 SQLite 不支持的方言；SQLite 只加载
    // SQLite 基线及 SQLite 专用增量迁移，避免误执行 PostgreSQL 历史迁移。
    return [join(__dirname, '..', 'migrations', '*-Sqlite*{.ts,.js}')];
  }
  return [join(__dirname, '..', 'migrations', '[0-9]*{.ts,.js}')];
}

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

  if (type === 'sqlite') {
    return {
      type: 'sqlite',
      database: env.DB_DATABASE || 'data/tgtc.sqlite',
      entities: [...databaseEntities],
      subscribers: [UuidSubscriber],
      migrations: getMigrationPatterns('sqlite'),
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
    migrations: getMigrationPatterns('postgres'),
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
