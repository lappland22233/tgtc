import { DataSource } from 'typeorm';
import { SqliteCreateStorageBackends1804000000000 } from './1804000000000-SqliteCreateStorageBackends';
import { SqliteAddFileStorageColumns1804100000000 } from './1804100000000-SqliteAddFileStorageColumns';
import { CreateStorageBackends1804000000000 } from './1804000000000-CreateStorageBackends';
import { AddFileStorageColumns1804100000000 } from './1804100000000-AddFileStorageColumns';

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
      type: 'sqlite',
      database: ':memory:',
      entities: [...databaseEntities],
      migrations: [
        SqliteEntitySchema1700000000000,
        SqliteSchemaAlignment1800000000000,
        SqliteCreateStorageBackends1804000000000,
        SqliteAddFileStorageColumns1804100000000,
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

    // files 存储三列 + 共享引用检查索引
    const columns = await dataSource.query('PRAGMA table_info("files")');
    const backendColumn = columns.find((c: { name: string }) => c.name === 'storageBackend');
    expect(backendColumn).toBeDefined();
    expect(backendColumn.dflt_value).toContain('telegram');
    expect(columns.find((c: { name: string }) => c.name === 'storageAccountId')).toBeDefined();
    expect(columns.find((c: { name: string }) => c.name === 'storageObjectRef')).toBeDefined();
    const fileIndexes = await dataSource.query('PRAGMA index_list("files")');
    expect(fileIndexes.find((i: { name: string }) => i.name === 'idx_files_storage_ref')).toBeDefined();
  });

  it('存量库（无新列）经增量迁移补齐，默认值 telegram 兼容历史数据', async () => {
    dataSource = new DataSource({
      type: 'sqlite',
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
    await new SqliteCreateStorageBackends1804000000000().up(runner);
    await runner.release();

    const rows = await dataSource.query('SELECT "storageBackend", "storageAccountId", "storageObjectRef" FROM "files"');
    expect(rows[0]).toMatchObject({ storageBackend: 'telegram', storageAccountId: null, storageObjectRef: null });
    const tables = await dataSource.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='storage_backends'`);
    expect(tables.length).toBe(1);
  });

  it('PG 迁移在 SQLite 连接上安全跳过（方言守卫）', async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [],
      migrations: [],
      synchronize: false,
    });
    await dataSource.initialize();
    const runner = dataSource.createQueryRunner();
    await new CreateStorageBackends1804000000000().up(runner);
    await new AddFileStorageColumns1804100000000().up(runner);
    await runner.release();
    const tables = await dataSource.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='storage_backends'`);
    expect(tables.length).toBe(0);
  });
});