import { DataSource, EntitySchema } from 'typeorm';

// SQLite 建库 + 全量迁移在 CI 满负载下可能超过 jest 默认 5s（该套件本身耗时数百毫秒，
// 整体套件同进程串行执行时会被资源争用拖慢）→ 统一放宽超时，避免偶发假失败。
jest.setTimeout(30_000);

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

    // 副本实体由基线按实体元数据建表，且必须带唯一约束与入站锚点索引（与 180290 增量迁移同口径）。
    const copyIndexes = await dataSource.query('PRAGMA index_list("telegram_file_copies")');
    expect(copyIndexes.find((index: { name: string }) => index.name === 'uq_tg_file_copies_owner_account'))
      .toMatchObject({ unique: 1 });
    expect(copyIndexes.find((index: { name: string }) => index.name === 'idx_tg_file_copies_anchor')).toBeDefined();

    // 账号与镜像实体同样由基线建表，索引口径必须与增量迁移一致。
    const accountIndexes = await dataSource.query('PRAGMA index_list("telegram_accounts")');
    expect(accountIndexes.find((index: { name: string }) => index.name === 'uq_tg_accounts_type_external'))
      .toMatchObject({ unique: 1 });
    expect(accountIndexes.find((index: { name: string }) => index.name === 'idx_tg_accounts_status')).toBeDefined();
    expect(accountIndexes.find((index: { name: string }) => index.name === 'idx_tg_accounts_enabled')).toBeDefined();

    const mirrorRuleIndexes = await dataSource.query('PRAGMA index_list("telegram_mirror_rules")');
    expect(mirrorRuleIndexes.find((index: { name: string }) => index.name === 'idx_tg_mirror_rules_enabled')).toBeDefined();

    const mirrorTaskIndexes = await dataSource.query('PRAGMA index_list("telegram_mirror_tasks")');
    expect(mirrorTaskIndexes.find((index: { name: string }) => index.name === 'uq_tg_mirror_tasks_idempotency'))
      .toMatchObject({ unique: 1 });
    expect(mirrorTaskIndexes.find((index: { name: string }) => index.name === 'idx_tg_mirror_tasks_next_retry')).toBeDefined();

    // 扩散轮次实体同样由基线建表：索引口径必须与 180350 增量迁移一致
    const attemptIndexes = await dataSource.query('PRAGMA index_list("telegram_replication_attempts")');
    expect(attemptIndexes.find((index: { name: string }) => index.name === 'idx_tg_replication_attempts_owner')).toBeDefined();
    expect(attemptIndexes.find((index: { name: string }) => index.name === 'idx_tg_replication_attempts_status')).toBeDefined();
    expect(attemptIndexes.find((index: { name: string }) => index.name === 'idx_tg_replication_attempts_reason')).toBeDefined();
    expect(attemptIndexes.find((index: { name: string }) => index.name === 'idx_tg_replication_attempts_updated')).toBeDefined();

    // 主群锚点实体同样由基线建表：唯一键与索引口径必须与 180360 增量迁移一致
    const anchorIndexes = await dataSource.query('PRAGMA index_list("telegram_main_chat_anchors")');
    expect(anchorIndexes.find((index: { name: string }) => index.name === 'uq_tg_main_chat_anchors_owner'))
      .toMatchObject({ unique: 1 });
    expect(anchorIndexes.find((index: { name: string }) => index.name === 'idx_tg_main_chat_anchors_anchor')).toBeDefined();

    const fileColumns = await dataSource.query('PRAGMA table_info("files")');
    expect(fileColumns.find((column: { name: string }) => column.name === 'telegramMessageId')).toBeDefined();
    expect(fileColumns.find((column: { name: string }) => column.name === 'telegramSourceAccountId')).toBeDefined();

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

  it('存量库升级：180230 自建 Bot 三表并为 access_logs 补 Bot 标识列', async () => {
    dataSource = new DataSource({ type: 'sqlite', database: ':memory:', entities: [], synchronize: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE TABLE "migrations" (
      "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      "timestamp" bigint NOT NULL, "name" varchar NOT NULL
    )`);
    await dataSource.query(`CREATE TABLE "access_logs" (
      "id" varchar PRIMARY KEY NOT NULL, "ip" varchar NOT NULL, "method" varchar(10) NOT NULL,
      "path" varchar(500) NOT NULL, "statusCode" integer NOT NULL, "responseSize" bigint NOT NULL DEFAULT 0,
      "duration" integer NOT NULL DEFAULT 0, "userAgent" varchar(500), "referer" varchar(300),
      "userId" varchar, "createdAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

    const { SqliteTelegramBotLinks1802300000000 } = require('./1802300000000-SqliteTelegramBotLinks') as typeof import('./1802300000000-SqliteTelegramBotLinks');
    await new SqliteTelegramBotLinks1802300000000().up(dataSource.createQueryRunner());

    const tables = await dataSource.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('telegram_bot_file_grants','telegram_bot_daily_usage','telegram_bot_whitelist')`,
    );
    expect(tables.map((row: { name: string }) => row.name).sort()).toEqual([
      'telegram_bot_daily_usage',
      'telegram_bot_file_grants',
      'telegram_bot_whitelist',
    ]);

    const grantIndexes = await dataSource.query('PRAGMA index_list("telegram_bot_file_grants")');
    expect(grantIndexes.find((index: { name: string }) => index.name === 'uq_tg_bot_grants_tokenHash'))
      .toMatchObject({ unique: 1 });
    expect(grantIndexes.find((index: { name: string }) => index.name === 'uq_tg_bot_grants_message'))
      .toMatchObject({ unique: 1 });

    const usageIndexes = await dataSource.query('PRAGMA index_list("telegram_bot_daily_usage")');
    expect(usageIndexes.find((index: { name: string }) => index.name === 'uq_tg_bot_daily_usage_user_date'))
      .toMatchObject({ unique: 1 });

    const whitelistIndexes = await dataSource.query('PRAGMA index_list("telegram_bot_whitelist")');
    expect(whitelistIndexes.find((index: { name: string }) => index.name === 'uq_tg_bot_whitelist_tgUser'))
      .toMatchObject({ unique: 1 });

    const accessLogColumns = await dataSource.query('PRAGMA table_info("access_logs")');
    expect(accessLogColumns.find((column: { name: string }) => column.name === 'botGrantId')).toBeDefined();
    expect(accessLogColumns.find((column: { name: string }) => column.name === 'botTelegramUserId')).toBeDefined();

    // 幂等：重复执行不报错。
    await new SqliteTelegramBotLinks1802300000000().up(dataSource.createQueryRunner());
  });

  it('存量库升级：180290 自建副本表并为 grants 补源账号列', async () => {
    dataSource = new DataSource({ type: 'sqlite', database: ':memory:', entities: [], synchronize: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE TABLE "migrations" (
      "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      "timestamp" bigint NOT NULL, "name" varchar NOT NULL
    )`);
    await dataSource.query(`CREATE TABLE "telegram_bot_file_grants" (
      "id" varchar PRIMARY KEY NOT NULL, "telegramUserId" varchar(32) NOT NULL
    )`);

    const { SqliteTelegramFileCopies1802900000000 } = require('./1802900000000-SqliteTelegramFileCopies') as typeof import('./1802900000000-SqliteTelegramFileCopies');
    await new SqliteTelegramFileCopies1802900000000().up(dataSource.createQueryRunner());

    const tables = await dataSource.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('telegram_file_copies','telegram_bot_file_grants')`,
    );
    expect(tables.map((row: { name: string }) => row.name).sort()).toEqual([
      'telegram_bot_file_grants',
      'telegram_file_copies',
    ]);

    const copyIndexes = await dataSource.query('PRAGMA index_list("telegram_file_copies")');
    expect(copyIndexes.find((index: { name: string }) => index.name === 'uq_tg_file_copies_owner_account'))
      .toMatchObject({ unique: 1 });
    expect(copyIndexes.find((index: { name: string }) => index.name === 'idx_tg_file_copies_anchor')).toBeDefined();
    expect(copyIndexes.find((index: { name: string }) => index.name === 'idx_tg_file_copies_owner')).toBeDefined();
    expect(copyIndexes.find((index: { name: string }) => index.name === 'idx_tg_file_copies_status')).toBeDefined();

    const grantColumns = await dataSource.query('PRAGMA table_info("telegram_bot_file_grants")');
    expect(grantColumns.find((column: { name: string }) => column.name === 'sourceAccountId')).toBeDefined();

    // 副本表可写，且唯一约束生效（重投幂等的前提）；不同账号可有各自副本。
    await dataSource.query(
      `INSERT INTO "telegram_file_copies" ("id","ownerType","ownerId","accountId","telegramFileId")
       VALUES ('c1','fileUnique','u1','bot1','file-1')`,
    );
    await expect(dataSource.query(
      `INSERT INTO "telegram_file_copies" ("id","ownerType","ownerId","accountId","telegramFileId")
       VALUES ('c2','fileUnique','u1','bot1','file-2')`,
    )).rejects.toThrow();
    await dataSource.query(
      `INSERT INTO "telegram_file_copies" ("id","ownerType","ownerId","accountId","telegramFileId")
       VALUES ('c3','fileUnique','u1','bot2','file-2')`,
    );

    // 幂等：重复执行不报错、不重复建表或重复加列。
    await new SqliteTelegramFileCopies1802900000000().up(dataSource.createQueryRunner());
    const copyCount = await dataSource.query('SELECT COUNT(*) AS count FROM "telegram_file_copies"');
    expect(copyCount[0].count).toBe(2);

    const integrity = await dataSource.query('PRAGMA integrity_check');
    expect(Object.values(integrity[0])).toEqual(['ok']);
  });

  it('存量库升级：180340 建立锚点一致性部分唯一索引且不误伤合法多账号副本', async () => {
    dataSource = new DataSource({ type: 'sqlite', database: ':memory:', entities: [], synchronize: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE TABLE "migrations" (
      "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      "timestamp" bigint NOT NULL, "name" varchar NOT NULL
    )`);
    await dataSource.query(`CREATE TABLE "telegram_file_copies" (
      "id" varchar PRIMARY KEY NOT NULL, "ownerType" varchar NOT NULL, "ownerId" varchar NOT NULL,
      "accountId" varchar NOT NULL, "telegramFileId" varchar NOT NULL,
      "chatId" varchar, "messageId" varchar, "fileSize" bigint, "status" varchar NOT NULL DEFAULT 'ready'
    )`);

    const { SqliteTelegramCopyAnchorGuard1803400000000 } = require('./1803400000000-SqliteTelegramCopyAnchorGuard') as typeof import('./1803400000000-SqliteTelegramCopyAnchorGuard');
    await new SqliteTelegramCopyAnchorGuard1803400000000().up(dataSource.createQueryRunner());

    const indexes = await dataSource.query('PRAGMA index_list("telegram_file_copies")');
    expect(indexes.find((index: { name: string }) => index.name === 'uq_tg_file_copies_anchor_account'))
      .toMatchObject({ unique: 1, partial: 1 });
    expect(indexes.find((index: { name: string }) => index.name === 'idx_tg_file_copies_anchor_owner')).toBeDefined();

    // 合法场景一：同一备份群里多个 Bot 各持同一条消息的副本（同锚点、不同账号）必须允许
    await dataSource.query(
      `INSERT INTO "telegram_file_copies" ("id","ownerType","ownerId","accountId","telegramFileId","chatId","messageId")
       VALUES ('c1','fileUnique','UNIQ-1','bot1','file-1','group','55')`,
    );
    await dataSource.query(
      `INSERT INTO "telegram_file_copies" ("id","ownerType","ownerId","accountId","telegramFileId","chatId","messageId")
       VALUES ('c2','fileUnique','UNIQ-1','bot2','file-2','group','55')`,
    );

    // 合法场景二：桥接双写（同一锚点额外写 file 命名空间、不同逻辑主键）必须允许
    await dataSource.query(
      `INSERT INTO "telegram_file_copies" ("id","ownerType","ownerId","accountId","telegramFileId","chatId","messageId")
       VALUES ('c3','file','file-1','bot1','file-1','group','55')`,
    );

    // 脏数据：同一账号在同一条消息上登记互相矛盾的逻辑主键必须被拦截
    await expect(dataSource.query(
      `INSERT INTO "telegram_file_copies" ("id","ownerType","ownerId","accountId","telegramFileId","chatId","messageId")
       VALUES ('c4','fileUnique','UNIQ-OTHER','bot1','file-9','group','55')`,
    )).rejects.toThrow();

    // 幂等：重复执行不报错
    await new SqliteTelegramCopyAnchorGuard1803400000000().up(dataSource.createQueryRunner());
    const count = await dataSource.query('SELECT COUNT(*) AS count FROM "telegram_file_copies"');
    expect(count[0].count).toBe(3);

    // down 只删本迁移新增的索引，不动数据
    await new SqliteTelegramCopyAnchorGuard1803400000000().down(dataSource.createQueryRunner());
    const afterDown = await dataSource.query('PRAGMA index_list("telegram_file_copies")');
    expect(afterDown.find((index: { name: string }) => index.name === 'uq_tg_file_copies_anchor_account')).toBeUndefined();
    expect(await dataSource.query('SELECT COUNT(*) AS count FROM "telegram_file_copies"')).toEqual([{ count: 3 }]);
  });

  it('存量库升级：180300/180310/180320 自建账号与镜像表并补 files 定位列', async () => {
    // 模拟旧基线库存量库：账号与镜像表尚不存在，files 也没有主副本定位列。
    dataSource = new DataSource({ type: 'sqlite', database: ':memory:', entities: [], synchronize: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE TABLE "migrations" (
      "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      "timestamp" bigint NOT NULL, "name" varchar NOT NULL
    )`);
    await dataSource.query(`CREATE TABLE "files" (
      "id" varchar PRIMARY KEY NOT NULL, "filename" varchar NOT NULL, "originalName" varchar NOT NULL,
      "uploaderId" varchar NOT NULL, "telegramFileId" varchar NOT NULL
    )`);

    const { SqliteCreateTelegramAccounts1803000000000 } = require('./1803000000000-SqliteCreateTelegramAccounts') as typeof import('./1803000000000-SqliteCreateTelegramAccounts');
    const { SqliteCreateTelegramMirror1803100000000 } = require('./1803100000000-SqliteCreateTelegramMirror') as typeof import('./1803100000000-SqliteCreateTelegramMirror');
    const { SqliteAddFileTelegramSourceFields1803200000000 } = require('./1803200000000-SqliteAddFileTelegramSourceFields') as typeof import('./1803200000000-SqliteAddFileTelegramSourceFields');

    await new SqliteCreateTelegramAccounts1803000000000().up(dataSource.createQueryRunner());
    await new SqliteCreateTelegramMirror1803100000000().up(dataSource.createQueryRunner());
    await new SqliteAddFileTelegramSourceFields1803200000000().up(dataSource.createQueryRunner());

    const tables = await dataSource.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('telegram_accounts','telegram_mirror_rules','telegram_mirror_tasks')`,
    );
    expect(tables.map((row: { name: string }) => row.name).sort()).toEqual([
      'telegram_accounts',
      'telegram_mirror_rules',
      'telegram_mirror_tasks',
    ]);

    const accountIndexes = await dataSource.query('PRAGMA index_list("telegram_accounts")');
    expect(accountIndexes.find((index: { name: string }) => index.name === 'uq_tg_accounts_type_external'))
      .toMatchObject({ unique: 1 });

    // 账号表可写：同一 (type, externalId) 重复登记必须被唯一约束拦截。
    await dataSource.query(
      `INSERT INTO "telegram_accounts" ("id","type","name","externalId","status","enabled","weight","maxInflight")
       VALUES ('a1','bot','主存储 Bot','123456','active',1,1,8)`,
    );
    await expect(dataSource.query(
      `INSERT INTO "telegram_accounts" ("id","type","name","externalId","status","enabled","weight","maxInflight")
       VALUES ('a2','bot','重复 Bot','123456','active',1,1,8)`,
    )).rejects.toThrow();

    // 镜像任务幂等键：同 (ruleId, ownerType, ownerId, sourceVersion) 只允许一条。
    await dataSource.query(
      `INSERT INTO "telegram_mirror_tasks" ("id","ruleId","ownerType","ownerId","sourceVersion","mode","status")
       VALUES ('t1','r1','file','f1',1,'bot_upload','queued')`,
    );
    await expect(dataSource.query(
      `INSERT INTO "telegram_mirror_tasks" ("id","ruleId","ownerType","ownerId","sourceVersion","mode","status")
       VALUES ('t2','r1','file','f1',1,'bot_upload','queued')`,
    )).rejects.toThrow();
    // 覆盖上传（版本递增）允许产生新任务。
    await dataSource.query(
      `INSERT INTO "telegram_mirror_tasks" ("id","ruleId","ownerType","ownerId","sourceVersion","mode","status")
       VALUES ('t3','r1','file','f1',2,'bot_upload','queued')`,
    );

    const fileColumns = await dataSource.query('PRAGMA table_info("files")');
    for (const name of ['telegramChatId', 'telegramMessageId', 'telegramFileUniqueId', 'telegramSourceAccountId']) {
      expect(fileColumns.find((column: { name: string }) => column.name === name)).toBeDefined();
    }

    // 幂等：重复执行不报错、不重复建表或重复加列。
    await new SqliteCreateTelegramAccounts1803000000000().up(dataSource.createQueryRunner());
    await new SqliteCreateTelegramMirror1803100000000().up(dataSource.createQueryRunner());
    await new SqliteAddFileTelegramSourceFields1803200000000().up(dataSource.createQueryRunner());
    expect(await dataSource.query('SELECT COUNT(*) AS count FROM "telegram_accounts"')).toEqual([{ count: 1 }]);
    expect(await dataSource.query('SELECT COUNT(*) AS count FROM "telegram_mirror_tasks"')).toEqual([{ count: 2 }]);

    const integrity = await dataSource.query('PRAGMA integrity_check');
    expect(Object.values(integrity[0])).toEqual(['ok']);
  });

  it('存量库升级：180360 自建主群锚点表（唯一键、索引齐全、可写、幂等）', async () => {
    dataSource = new DataSource({ type: 'sqlite', database: ':memory:', entities: [], synchronize: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE TABLE "migrations" (
      "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      "timestamp" bigint NOT NULL, "name" varchar NOT NULL
    )`);

    const { SqliteCreateTelegramMainChatAnchors1803600000000 } = require('./1803600000000-SqliteCreateTelegramMainChatAnchors') as typeof import('./1803600000000-SqliteCreateTelegramMainChatAnchors');
    await new SqliteCreateTelegramMainChatAnchors1803600000000().up(dataSource.createQueryRunner());

    const tables = await dataSource.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_main_chat_anchors'`,
    );
    expect(tables).toHaveLength(1);

    const indexes = await dataSource.query('PRAGMA index_list("telegram_main_chat_anchors")');
    expect(indexes.find((index: { name: string }) => index.name === 'uq_tg_main_chat_anchors_owner'))
      .toMatchObject({ unique: 1 });
    expect(indexes.find((index: { name: string }) => index.name === 'idx_tg_main_chat_anchors_anchor')).toBeDefined();

    // 同一归属对象只允许一行锚点：多规则共享落点是幂等的前提
    await dataSource.query(
      `INSERT INTO "telegram_main_chat_anchors"
        ("id","ownerType","ownerId","anchorChatId","anchorMessageId","status")
       VALUES ('a1','grant','g1','-100999','777','ready')`,
    );
    await expect(dataSource.query(
      `INSERT INTO "telegram_main_chat_anchors"
        ("id","ownerType","ownerId","anchorChatId","anchorMessageId","status")
       VALUES ('a2','grant','g1','-100999','778','ready')`,
    )).rejects.toThrow();
    // 不同归属对象互不影响
    await dataSource.query(
      `INSERT INTO "telegram_main_chat_anchors"
        ("id","ownerType","ownerId","anchorChatId","status","lastError")
       VALUES ('a3','file','f1','-100999','failed','权限不足')`,
    );

    // 策略 B 只做服务端转发：没有字节传输列
    const columns = await dataSource.query('PRAGMA table_info("telegram_main_chat_anchors")');
    expect(columns.find((column: { name: string }) => column.name === 'bytesTransferred')).toBeUndefined();

    // 幂等：重复执行不报错、不重复建表
    await new SqliteCreateTelegramMainChatAnchors1803600000000().up(dataSource.createQueryRunner());
    expect(await dataSource.query('SELECT COUNT(*) AS count FROM "telegram_main_chat_anchors"')).toEqual([{ count: 2 }]);

    // down 只删本迁移新增的表与索引
    await new SqliteCreateTelegramMainChatAnchors1803600000000().down(dataSource.createQueryRunner());
    const afterDown = await dataSource.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_main_chat_anchors'`,
    );
    expect(afterDown).toHaveLength(0);

    const integrity = await dataSource.query('PRAGMA integrity_check');
    expect(Object.values(integrity[0])).toEqual(['ok']);
  });

  it('存量库升级：180350 自建扩散轮次表（索引齐全、可写、幂等）', async () => {
    dataSource = new DataSource({ type: 'sqlite', database: ':memory:', entities: [], synchronize: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE TABLE "migrations" (
      "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      "timestamp" bigint NOT NULL, "name" varchar NOT NULL
    )`);

    const { SqliteCreateTelegramReplicationAttempts1803500000000 } = require('./1803500000000-SqliteCreateTelegramReplicationAttempts') as typeof import('./1803500000000-SqliteCreateTelegramReplicationAttempts');
    await new SqliteCreateTelegramReplicationAttempts1803500000000().up(dataSource.createQueryRunner());

    const tables = await dataSource.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_replication_attempts'`,
    );
    expect(tables).toHaveLength(1);

    const indexes = await dataSource.query('PRAGMA index_list("telegram_replication_attempts")');
    for (const name of [
      'idx_tg_replication_attempts_owner',
      'idx_tg_replication_attempts_status',
      'idx_tg_replication_attempts_reason',
      'idx_tg_replication_attempts_updated',
    ]) {
      expect(indexes.find((index: { name: string }) => index.name === name)).toBeDefined();
    }

    // 轮次表可写：策略 B 不发生文件字节二次传输，因此没有 bytesTransferred 列
    await dataSource.query(
      `INSERT INTO "telegram_replication_attempts"
        ("id","ownerType","ownerId","status","desiredCount","baselineReadyCount")
       VALUES ('a1','file','file-1','succeeded',3,1)`,
    );
    const columns = await dataSource.query('PRAGMA table_info("telegram_replication_attempts")');
    expect(columns.find((column: { name: string }) => column.name === 'bytesTransferred')).toBeUndefined();
    expect(columns.find((column: { name: string }) => column.name === 'claimedAccountIds')).toBeDefined();

    // 幂等：重复执行不报错、不重复建表
    await new SqliteCreateTelegramReplicationAttempts1803500000000().up(dataSource.createQueryRunner());
    expect(await dataSource.query('SELECT COUNT(*) AS count FROM "telegram_replication_attempts"')).toEqual([{ count: 1 }]);

    // down 只删本迁移新增的表与索引
    await new SqliteCreateTelegramReplicationAttempts1803500000000().down(dataSource.createQueryRunner());
    const afterDown = await dataSource.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_replication_attempts'`,
    );
    expect(afterDown).toHaveLength(0);

    const integrity = await dataSource.query('PRAGMA integrity_check');
    expect(Object.values(integrity[0])).toEqual(['ok']);
  });
});
