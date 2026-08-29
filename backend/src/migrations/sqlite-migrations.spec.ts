import { DataSource, EntitySchema } from 'typeorm';

describe('SQLite schema migrations（隔离内存库）', () => {
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

  it('按顺序执行基线与增量迁移，并保留 partial unique 索引', async () => {
    // 实体装饰器在模块首次加载时按 DB_TYPE 固化列类型，必须先设置 sqlite 再加载。
    const { databaseEntities } = require('../database/entities') as typeof import('../database/entities');
    const { SqliteEntitySchema1700000000000 } = require('./0000000000000-SqliteEntitySchema') as typeof import('./0000000000000-SqliteEntitySchema');
    const { SqliteSchemaAlignment1800000000000 } = require('./1800000000000-SqliteSchemaAlignment') as typeof import('./1800000000000-SqliteSchemaAlignment');

    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [...databaseEntities],
      migrations: [SqliteEntitySchema1700000000000, SqliteSchemaAlignment1800000000000],
      migrationsRun: true,
      synchronize: false,
    });

    await dataSource.initialize();

    const migrations = await dataSource.query('SELECT name FROM migrations ORDER BY timestamp');
    expect(migrations.map((row: { name: string }) => row.name)).toEqual([
      'SqliteEntitySchema1700000000000',
      'SqliteSchemaAlignment1800000000000',
    ]);

    const folderIndexes = await dataSource.query('PRAGMA index_list("folders")');
    const partialUnique = folderIndexes.find((index: { name: string }) => index.name === 'uq_folders_owner_parent_name_active');
    expect(partialUnique).toMatchObject({ unique: 1, partial: 1 });

    const verifyIndexes = await dataSource.query('PRAGMA index_list("file_verify_tasks")');
    expect(verifyIndexes.find((index: { name: string }) => index.name === 'uq_file_verify_tasks_active_slot'))
      .toMatchObject({ unique: 1, partial: 1 });

    const integrity = await dataSource.query('PRAGMA integrity_check');
    expect(Object.values(integrity[0])).toEqual(['ok']);
  });

  it('为存量 folders 回填自环与完整祖先关系', async () => {
    const { databaseEntities } = require('../database/entities') as typeof import('../database/entities');
    const { SqliteSchemaAlignment1800000000000 } = require('./1800000000000-SqliteSchemaAlignment') as typeof import('./1800000000000-SqliteSchemaAlignment');
    dataSource = new DataSource({ type: 'sqlite', database: ':memory:', entities: [...databaseEntities], synchronize: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE TABLE "folders" (
      "id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "ownerId" varchar NOT NULL,
      "parentId" varchar, "isDeleted" boolean NOT NULL DEFAULT 0,
      "deleteRequestedAt" datetime, "deleteScheduledAt" datetime,
      "createdAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await dataSource.query(`INSERT INTO "folders" ("id", "name", "ownerId", "parentId") VALUES
      ('root', 'root', 'owner', NULL), ('child', 'child', 'owner', 'root'), ('leaf', 'leaf', 'owner', 'child')`);

    await new SqliteSchemaAlignment1800000000000().up(dataSource.createQueryRunner());

    const rows = await dataSource.query('SELECT "id_ancestor", "id_descendant" FROM "folder_closure" ORDER BY 1, 2');
    expect(rows).toEqual([
      { id_ancestor: 'child', id_descendant: 'child' },
      { id_ancestor: 'child', id_descendant: 'leaf' },
      { id_ancestor: 'leaf', id_descendant: 'leaf' },
      { id_ancestor: 'root', id_descendant: 'child' },
      { id_ancestor: 'root', id_descendant: 'leaf' },
      { id_ancestor: 'root', id_descendant: 'root' },
    ]);
  });

  it('从旧基线升级时补齐 metadata.uniques 与列级唯一约束', async () => {
    const LegacyEntity = new EntitySchema({
      name: 'LegacyUniqueEntity',
      tableName: 'legacy_unique_entities',
      columns: {
        id: { type: String, primary: true },
        tenant: { type: String },
        code: { type: String },
        token: { type: String, unique: true },
      },
      uniques: [{ name: 'uq_legacy_tenant_code', columns: ['tenant', 'code'] }],
    });
    const { SqliteSchemaAlignment1800000000000 } = require('./1800000000000-SqliteSchemaAlignment') as typeof import('./1800000000000-SqliteSchemaAlignment');
    dataSource = new DataSource({ type: 'sqlite', database: ':memory:', entities: [LegacyEntity], synchronize: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE TABLE "legacy_unique_entities" (
      "id" varchar PRIMARY KEY NOT NULL, "tenant" varchar NOT NULL, "code" varchar NOT NULL, "token" varchar NOT NULL
    )`);
    await dataSource.query(`INSERT INTO "legacy_unique_entities" VALUES ('1', 'a', 'x', 'token-1')`);

    await new SqliteSchemaAlignment1800000000000().up(dataSource.createQueryRunner());

    await expect(dataSource.query(`INSERT INTO "legacy_unique_entities" VALUES ('2', 'a', 'x', 'token-2')`)).rejects.toThrow();
    await expect(dataSource.query(`INSERT INTO "legacy_unique_entities" VALUES ('3', 'b', 'y', 'token-1')`)).rejects.toThrow();
  });

  it('旧基线存在重复值时在补唯一约束前给出明确错误', async () => {
    const LegacyEntity = new EntitySchema({
      name: 'LegacyDuplicateEntity',
      tableName: 'legacy_duplicate_entities',
      columns: {
        id: { type: String, primary: true },
        tenant: { type: String },
        code: { type: String },
      },
      uniques: [{ name: 'uq_legacy_duplicate', columns: ['tenant', 'code'] }],
    });
    const { SqliteSchemaAlignment1800000000000 } = require('./1800000000000-SqliteSchemaAlignment') as typeof import('./1800000000000-SqliteSchemaAlignment');
    dataSource = new DataSource({ type: 'sqlite', database: ':memory:', entities: [LegacyEntity], synchronize: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE TABLE "legacy_duplicate_entities" (
      "id" varchar PRIMARY KEY NOT NULL, "tenant" varchar NOT NULL, "code" varchar NOT NULL
    )`);
    await dataSource.query(`INSERT INTO "legacy_duplicate_entities" VALUES ('1', 'a', 'x'), ('2', 'a', 'x')`);

    await expect(new SqliteSchemaAlignment1800000000000().up(dataSource.createQueryRunner()))
      .rejects.toThrow('无法补齐唯一约束 legacy_duplicate_entities(tenant, code): 升级前检测到重复数据');
  });

  it('存量 folders 根目录重名时在创建 COALESCE 唯一索引前明确失败', async () => {
    const { databaseEntities } = require('../database/entities') as typeof import('../database/entities');
    const { SqliteSchemaAlignment1800000000000 } = require('./1800000000000-SqliteSchemaAlignment') as typeof import('./1800000000000-SqliteSchemaAlignment');
    dataSource = new DataSource({ type: 'sqlite', database: ':memory:', entities: [...databaseEntities], synchronize: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE TABLE "folders" (
      "id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "ownerId" varchar NOT NULL,
      "parentId" varchar, "isDeleted" boolean NOT NULL DEFAULT 0,
      "deleteRequestedAt" datetime, "deleteScheduledAt" datetime,
      "createdAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await dataSource.query(`INSERT INTO "folders" ("id", "name", "ownerId", "parentId") VALUES
      ('one', 'same', 'owner', NULL), ('two', 'same', 'owner', NULL)`);

    await expect(new SqliteSchemaAlignment1800000000000().up(dataSource.createQueryRunner()))
      .rejects.toThrow('升级前检测到同层活动文件夹重名');
  });

  it('存量表缺少非空无默认列时明确失败而非静默跳过', async () => {
    const RequiredEntity = new EntitySchema({
      name: 'RequiredEntity',
      tableName: 'required_entities',
      columns: {
        id: { type: String, primary: true },
        requiredValue: { type: String, nullable: false },
      },
    });
    const { SqliteSchemaAlignment1800000000000 } = require('./1800000000000-SqliteSchemaAlignment') as typeof import('./1800000000000-SqliteSchemaAlignment');
    dataSource = new DataSource({ type: 'sqlite', database: ':memory:', entities: [RequiredEntity], synchronize: false });
    await dataSource.initialize();
    await dataSource.query('CREATE TABLE "required_entities" ("id" varchar PRIMARY KEY NOT NULL)');
    await dataSource.query('INSERT INTO "required_entities" ("id") VALUES (?)', ['existing']);

    await expect(new SqliteSchemaAlignment1800000000000().up(dataSource.createQueryRunner()))
      .rejects.toThrow('无法安全新增非空无默认列 required_entities.requiredValue');
  });
});
