import { DataSource, EntitySchema } from 'typeorm';

function sqliteAffinity(type: string): string {
  const normalized = type.toUpperCase();
  if (normalized.includes('INT')) return 'INTEGER';
  if (normalized.includes('CHAR') || normalized.includes('CLOB') || normalized.includes('TEXT')) return 'TEXT';
  if (normalized.includes('BLOB') || !normalized) return 'BLOB';
  if (normalized.includes('REAL') || normalized.includes('FLOA') || normalized.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}

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

    const userColumns = await dataSource.query('PRAGMA table_info("users")');
    const isBanned = userColumns.find((column: { name: string }) => column.name === 'isBanned');
    expect(isBanned?.type.toLowerCase()).toBe('boolean');
    expect(sqliteAffinity(isBanned.type)).toBe('NUMERIC');

    const closureForeignKeys = await dataSource.query('PRAGMA foreign_key_list("folder_closure")') as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    expect(closureForeignKeys).toHaveLength(2);
    expect(new Set(closureForeignKeys.map((foreignKey) => foreignKey.id)).size).toBe(2);
    expect(closureForeignKeys.map((foreignKey) => ({
      seq: foreignKey.seq,
      table: foreignKey.table,
      from: foreignKey.from,
      to: foreignKey.to,
      onDelete: foreignKey.on_delete,
    })).sort((left, right) => left.from.localeCompare(right.from))).toEqual([
      { seq: 0, table: 'folders', from: 'id_ancestor', to: 'id', onDelete: 'CASCADE' },
      { seq: 0, table: 'folders', from: 'id_descendant', to: 'id', onDelete: 'CASCADE' },
    ]);

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

  it('存量库升级：180210 自建 directory_names 并回填历史活跃实体', async () => {
    // 模拟旧基线（基线已执行、directory_names 尚不存在）的存量库。
    dataSource = new DataSource({ type: 'sqlite', database: ':memory:', entities: [], synchronize: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE TABLE "migrations" (
      "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      "timestamp" bigint NOT NULL, "name" varchar NOT NULL
    )`);
    await dataSource.query(`CREATE TABLE "folders" (
      "id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "ownerId" varchar NOT NULL,
      "parentId" varchar, "isDeleted" boolean NOT NULL DEFAULT 0,
      "createdAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await dataSource.query(`CREATE TABLE "files" (
      "id" varchar PRIMARY KEY NOT NULL, "originalName" varchar NOT NULL, "uploaderId" varchar NOT NULL,
      "folderId" varchar, "isDeleted" boolean NOT NULL DEFAULT 0,
      "createdAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await dataSource.query(`INSERT INTO "folders" ("id", "name", "ownerId", "parentId") VALUES
      ('f1', 'Reports', 'owner', NULL), ('f2', 'Archive', 'owner', 'f1')`);
    await dataSource.query(`INSERT INTO "files" ("id", "originalName", "uploaderId", "folderId") VALUES
      ('doc1', 'Report.PDF', 'owner', 'f1'), ('doc2', 'notes.txt', 'owner', NULL)`);
    // 已软删实体不回填。
    await dataSource.query(`INSERT INTO "files" ("id", "originalName", "uploaderId", "folderId", "isDeleted") VALUES
      ('doc3', 'deleted.txt', 'owner', NULL, 1)`);

    const { SqliteCreateDirectoryNames1802100000000 } = require('./1802100000000-SqliteCreateDirectoryNames') as typeof import('./1802100000000-SqliteCreateDirectoryNames');
    await new SqliteCreateDirectoryNames1802100000000().up(dataSource.createQueryRunner());

    const table = await dataSource.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='directory_names'`);
    expect(table).toHaveLength(1);

    const indexes = await dataSource.query('PRAGMA index_list("directory_names")');
    expect(indexes.find((index: { name: string }) => index.name === 'uq_directory_names_active'))
      .toMatchObject({ unique: 1, partial: 1 });
    expect(indexes.find((index: { name: string }) => index.name === 'idx_directory_names_entity')).toBeDefined();

    const rows = await dataSource.query('SELECT "entityType", "entityId", "nameKey" FROM "directory_names" ORDER BY "entityType", "entityId"');
    expect(rows).toEqual([
      { entityType: 'file', entityId: 'doc1', nameKey: 'report.pdf' },
      { entityType: 'file', entityId: 'doc2', nameKey: 'notes.txt' },
      { entityType: 'folder', entityId: 'f1', nameKey: 'reports' },
      { entityType: 'folder', entityId: 'f2', nameKey: 'archive' },
    ]);

    // 幂等：重复执行不报错、不重复回填。
    await new SqliteCreateDirectoryNames1802100000000().up(dataSource.createQueryRunner());
    const recount = await dataSource.query('SELECT COUNT(*) AS count FROM "directory_names"');
    expect(recount[0].count).toBe(4);
  });

  it('存量库升级：180220 自建 API Key 治理两表并补密文列', async () => {
    dataSource = new DataSource({ type: 'sqlite', database: ':memory:', entities: [], synchronize: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE TABLE "migrations" (
      "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      "timestamp" bigint NOT NULL, "name" varchar NOT NULL
    )`);
    await dataSource.query(`CREATE TABLE "api_keys" (
      "id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "userId" varchar NOT NULL
    )`);

    const { SqliteApiKeySecurityGovernance1802200000000 } = require('./1802200000000-SqliteApiKeySecurityGovernance') as typeof import('./1802200000000-SqliteApiKeySecurityGovernance');
    await new SqliteApiKeySecurityGovernance1802200000000().up(dataSource.createQueryRunner());

    const tables = await dataSource.query(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('api_key_ip_allowlist','api_key_usage_logs')`);
    expect(tables.map((row: { name: string }) => row.name).sort()).toEqual(['api_key_ip_allowlist', 'api_key_usage_logs']);

    const allowlistIndexes = await dataSource.query('PRAGMA index_list("api_key_ip_allowlist")');
    expect(allowlistIndexes.find((index: { name: string }) => index.name === 'idx_api_key_ip_allowlist_keyId')).toBeDefined();

    const usageIndexes = await dataSource.query('PRAGMA index_list("api_key_usage_logs")');
    expect(usageIndexes.find((index: { name: string }) => index.name === 'idx_api_key_usage_logs_keyId_createdAt')).toBeDefined();
    expect(usageIndexes.find((index: { name: string }) => index.name === 'idx_api_key_usage_logs_userId_createdAt')).toBeDefined();
    expect(usageIndexes.find((index: { name: string }) => index.name === 'idx_api_key_usage_logs_createdAt')).toBeDefined();

    // 治理表可写（认证链路查询不再 500）。
    await dataSource.query(`INSERT INTO "api_key_ip_allowlist" ("id", "apiKeyId", "rule") VALUES ('r1', 'k1', '10.0.0.0/8')`);
    await dataSource.query(`INSERT INTO "api_key_usage_logs" ("id", "apiKeyId", "userId", "method", "route", "ip") VALUES ('l1', 'k1', 'u1', 'GET', '/api/files', '10.1.2.3')`);
    expect(await dataSource.query('SELECT COUNT(*) AS count FROM "api_key_ip_allowlist"')).toEqual([{ count: 1 }]);
    expect(await dataSource.query('SELECT COUNT(*) AS count FROM "api_key_usage_logs"')).toEqual([{ count: 1 }]);

    const keyColumns = await dataSource.query('PRAGMA table_info("api_keys")');
    expect(keyColumns.find((column: { name: string }) => column.name === 'keyCipher')).toBeDefined();
    expect(keyColumns.find((column: { name: string }) => column.name === 'cipherVersion')).toBeDefined();

    // 幂等：重复执行不报错。
    await new SqliteApiKeySecurityGovernance1802200000000().up(dataSource.createQueryRunner());
  });
});
