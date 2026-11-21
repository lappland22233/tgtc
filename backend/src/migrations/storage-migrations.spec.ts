import { DataSource } from 'typeorm';
import { SqliteCreateStorageBackends1804000000000 } from './1804000000000-SqliteCreateStorageBackends';
import { SqliteAddFileStorageColumns1804100000000 } from './1804100000000-SqliteAddFileStorageColumns';
import { SqliteAddGrantStorageColumns1804200000000 } from './1804200000000-SqliteAddGrantStorageColumns';
import { SqliteAddGDriveCacheColumns1804300000000 } from './1804300000000-SqliteAddGDriveCacheColumns';
import { CreateStorageBackends1804000000000 } from './1804000000000-CreateStorageBackends';
import { AddFileStorageColumns1804100000000 } from './1804100000000-AddFileStorageColumns';
import { AddGrantStorageColumns1804200000000 } from './1804200000000-AddGrantStorageColumns';
import { AddGDriveCacheColumns1804300000000 } from './1804300000000-AddGDriveCacheColumns';

jest.setTimeout(30_000);

describe('存储后端迁移（SQLite 隔离内存库）', () => {
  let dataSource: DataSource;
  const originalDbType = process.env.DB_TYPE;

  beforeEach(() => {
    process.env.DB_TYPE = 'sqlite';
    jest.resetModules();
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (originalDbType === undefined) delete process.env.DB_TYPE;
    else process.env.DB_TYPE = originalDbType;
  });

  it('基线已建表时增量迁移幂等（不重复建表/加列）', async () => {
    const { databaseEntities } = require('../database/entities') as typeof import('../database/entities');
    const { SqliteEntitySchema1700000000000 } = require('./0000000000000-SqliteEntitySchema') as typeof import('./0000000000000-SqliteEntitySchema');
    const { SqliteSchemaAlignment1800000000000 } = require('./1800000000000-SqliteSchemaAlignment') as typeof import('./1800000000000-SqliteSchemaAlignment');

    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [...databaseEntities],
      migrations: [
        SqliteEntitySchema1700000000000,
        SqliteSchemaAlignment1800000000000,
        SqliteCreateStorageBackends1804000000000,
        SqliteAddFileStorageColumns1804100000000,
        SqliteAddGrantStorageColumns1804200000000,
        SqliteAddGDriveCacheColumns1804300000000,
      ],
      migrationsRun: true,
      synchronize: false,
    });
    await dataSource.initialize();

    // storage_backends 表与索引口径（与 PG 迁移一致）
    const indexes = await dataSource.query('PRAGMA index_list("storage_backends")');
    expect(indexes.find((i: { name: string }) => i.name === 'uq_storage_backends_type_name'))
      .toMatchObject({ unique: 1 });
    expect(indexes.find((i: { name: string }) => i.name === 'idx_storage_backends_status')).toBeDefined();
    expect(indexes.find((i: { name: string }) => i.name === 'idx_storage_backends_enabled')).toBeDefined();

    // files 存储列与 GDrive 缓存三列
    const columns = await dataSource.query('PRAGMA table_info("files")');
    const backendColumn = columns.find((c: { name: string }) => c.name === 'storageBackend');
    expect(backendColumn).toBeDefined();
    expect(backendColumn.dflt_value).toContain('telegram');
    expect(columns.find((c: { name: string }) => c.name === 'storageAccountId')).toBeDefined();
    expect(columns.find((c: { name: string }) => c.name === 'storageObjectRef')).toBeDefined();
    expect(columns.find((c: { name: string }) => c.name === 'gdriveCacheAccountId')).toBeDefined();
    expect(columns.find((c: { name: string }) => c.name === 'gdriveCacheObjectRef')).toBeDefined();
    expect(columns.find((c: { name: string }) => c.name === 'gdriveCacheStatus')).toBeDefined();
    const fileIndexes = await dataSource.query('PRAGMA index_list("files")');
    expect(fileIndexes.find((i: { name: string }) => i.name === 'idx_files_storage_ref')).toBeDefined();
    expect(fileIndexes.find((i: { name: string }) => i.name === 'idx_files_gdrive_cache_ref')).toBeDefined();

    // telegram_bot_file_grants 存储列与 GDrive 缓存三列
    const grantColumns = await dataSource.query('PRAGMA table_info("telegram_bot_file_grants")');
    const grantBackendCol = grantColumns.find((c: { name: string }) => c.name === 'storageBackend');
    expect(grantBackendCol).toBeDefined();
    expect(grantBackendCol.dflt_value).toContain('telegram');
    expect(grantColumns.find((c: { name: string }) => c.name === 'storageAccountId')).toBeDefined();
    expect(grantColumns.find((c: { name: string }) => c.name === 'storageObjectRef')).toBeDefined();
    expect(grantColumns.find((c: { name: string }) => c.name === 'storagePurgedAt')).toBeDefined();
    expect(grantColumns.find((c: { name: string }) => c.name === 'gdriveCacheAccountId')).toBeDefined();
    expect(grantColumns.find((c: { name: string }) => c.name === 'gdriveCacheObjectRef')).toBeDefined();
    expect(grantColumns.find((c: { name: string }) => c.name === 'gdriveCacheStatus')).toBeDefined();
    const grantIndexes = await dataSource.query('PRAGMA index_list("telegram_bot_file_grants")');
    expect(grantIndexes.find((i: { name: string }) => i.name === 'idx_tg_bot_grants_purge_sweep')).toBeDefined();
    expect(grantIndexes.find((i: { name: string }) => i.name === 'idx_tg_bot_grants_gdrive_cache_ref')).toBeDefined();
  });

  it('存量库（无新列）经增量迁移补齐，默认值 telegram 兼容历史数据', async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [],
      migrations: [],
      synchronize: false,
    });
    await dataSource.initialize();
    // 模拟存量 files 表（仅旧列）
    await dataSource.query(`
      CREATE TABLE "files" (
        "id" varchar PRIMARY KEY NOT NULL,
        "filename" varchar NOT NULL,
        "telegramFileId" varchar NOT NULL,
        "uploadVersion" integer NOT NULL DEFAULT 1
      )
    `);
    await dataSource.query(
      `INSERT INTO "files" ("id", "filename", "telegramFileId") VALUES ('f1', 'tg-ref', 'tg-ref')`,
    );

    const runner = dataSource.createQueryRunner();
    await new SqliteAddFileStorageColumns1804100000000().up(runner);
    // 再跑一次验证幂等
    await new SqliteAddFileStorageColumns1804100000000().up(runner);
    await new SqliteAddGDriveCacheColumns1804300000000().up(runner);
    await new SqliteAddGDriveCacheColumns1804300000000().up(runner);
    await new SqliteCreateStorageBackends1804000000000().up(runner);
    await runner.release();

    const rows = await dataSource.query('SELECT "storageBackend", "storageAccountId", "storageObjectRef", "gdriveCacheAccountId", "gdriveCacheObjectRef", "gdriveCacheStatus" FROM "files"');
    expect(rows[0]).toMatchObject({
      storageBackend: 'telegram',
      storageAccountId: null,
      storageObjectRef: null,
      gdriveCacheAccountId: null,
      gdriveCacheObjectRef: null,
      gdriveCacheStatus: 'none',
    });
    const tables = await dataSource.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='storage_backends'`);
    expect(tables.length).toBe(1);
  });

  it('PG 迁移在 SQLite 连接上安全跳过（方言守卫）', async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [],
      migrations: [],
      synchronize: false,
    });
    await dataSource.initialize();
    const runner = dataSource.createQueryRunner();
    await new CreateStorageBackends1804000000000().up(runner);
    await new AddFileStorageColumns1804100000000().up(runner);
    await new AddGrantStorageColumns1804200000000().up(runner);
    await new AddGDriveCacheColumns1804300000000().up(runner);
    await runner.release();
    const tables = await dataSource.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='storage_backends'`);
    expect(tables.length).toBe(0);
  });
});