import {
  beginPostgresReadOnlySnapshot,
  publishMigratedFile,
  publishMigrationArtifacts,
  sqliteForeignKeyMatches,
  sqliteIndexMatches,
} from './data-migrator-utils';

describe('beginPostgresReadOnlySnapshot', () => {
  it('在读取前依次建立 repeatable read 与 read only 事务', async () => {
    const calls: string[] = [];
    await beginPostgresReadOnlySnapshot({
      connect: async () => { calls.push('connect'); },
      startTransaction: async (level) => { calls.push(`transaction:${level}`); },
      query: async (sql) => { calls.push(`query:${sql}`); },
    });
    expect(calls).toEqual([
      'connect',
      'transaction:REPEATABLE READ',
      'query:SET TRANSACTION READ ONLY',
    ]);
  });
});

describe('sqliteForeignKeyMatches', () => {
  const folderForeignKeys = [
    { id: 0, seq: 0, table: 'folders', from: 'id_descendant', to: 'id', on_delete: 'CASCADE' },
    { id: 1, seq: 0, table: 'folders', from: 'id_ancestor', to: 'id', on_delete: 'CASCADE' },
  ];

  it('区分两个指向同一张表的独立单列外键', () => {
    expect(sqliteForeignKeyMatches(folderForeignKeys, {
      columns: ['id_ancestor'], referencedTable: 'folders', referencedColumns: ['id'], onDelete: 'CASCADE',
    })).toBe(true);
    expect(sqliteForeignKeyMatches(folderForeignKeys, {
      columns: ['id_descendant'], referencedTable: 'folders', referencedColumns: ['id'], onDelete: 'cascade',
    })).toBe(true);
  });

  it('按 id 与 seq 匹配完整复合外键，拒绝乱序和前缀匹配', () => {
    const rows = [
      { id: 2, seq: 1, table: 'parents', from: 'tenant_id', to: 'tenant_id', on_delete: 'CASCADE' },
      { id: 3, seq: 0, table: 'parents', from: 'alternate_id', to: 'id', on_delete: 'CASCADE' },
      { id: 2, seq: 0, table: 'parents', from: 'parent_id', to: 'id', on_delete: 'CASCADE' },
    ];
    expect(sqliteForeignKeyMatches(rows, {
      columns: ['parent_id', 'tenant_id'],
      referencedTable: 'parents',
      referencedColumns: ['id', 'tenant_id'],
      onDelete: 'CASCADE',
    })).toBe(true);
    expect(sqliteForeignKeyMatches(rows, {
      columns: ['tenant_id', 'parent_id'],
      referencedTable: 'parents',
      referencedColumns: ['tenant_id', 'id'],
      onDelete: 'CASCADE',
    })).toBe(false);
    expect(sqliteForeignKeyMatches(rows, {
      columns: ['parent_id'], referencedTable: 'parents', referencedColumns: ['id'], onDelete: 'CASCADE',
    })).toBe(false);
  });

  it('拒绝删除动作不一致的外键', () => {
    expect(sqliteForeignKeyMatches(folderForeignKeys, {
      columns: ['id_ancestor'], referencedTable: 'folders', referencedColumns: ['id'], onDelete: 'SET NULL',
    })).toBe(false);
  });
});

describe('sqliteIndexMatches', () => {
  it('通过 sqlite_master SQL 识别 folders 的 COALESCE 部分唯一索引', () => {
    expect(sqliteIndexMatches({
      name: 'uq_folders_owner_parent_name_active',
      columns: ['ownerId', 'name'],
      unique: true,
      where: '"isDeleted" = 0',
      sql: `CREATE UNIQUE INDEX "uq_folders_owner_parent_name_active"
        ON "folders" ("ownerId", COALESCE("parentId", ''), "name") WHERE "isDeleted" = 0`,
    }, {
      name: 'uq_folders_owner_parent_name_active',
      columns: ['ownerId', 'parentId', 'name'],
      unique: true,
      where: '"isDeleted" = false',
      sql: `CREATE UNIQUE INDEX "uq_folders_owner_parent_name_active" ON "folders"
        ("ownerId", COALESCE("parentId", ''), "name") WHERE "isDeleted" = false`,
    })).toBe(true);
  });
});

describe('publishMigratedFile', () => {
  it('第二步 rename 失败时恢复原目标文件', () => {
    const files = new Set(['target.sqlite', 'temporary.sqlite']);
    let renameCalls = 0;
    const rename = jest.fn((from: string, to: string) => {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error('publish failed');
      if (!files.delete(from)) throw new Error(`missing ${from}`);
      files.add(to);
    });

    expect(() => publishMigratedFile('temporary.sqlite', 'target.sqlite', 'target.sqlite.backup', {
      exists: (path) => files.has(path),
      rename,
    })).toThrow('publish failed');

    expect(rename.mock.calls).toEqual([
      ['target.sqlite', 'target.sqlite.backup'],
      ['temporary.sqlite', 'target.sqlite'],
      ['target.sqlite.backup', 'target.sqlite'],
    ]);
    expect(files.has('target.sqlite')).toBe(true);
    expect(files.has('target.sqlite.backup')).toBe(false);
    expect(files.has('temporary.sqlite')).toBe(true);
  });
});

describe('publishMigrationArtifacts', () => {
  it('报告发布失败时保持旧数据库与旧报告不变', () => {
    const files = new Set(['target.sqlite', 'temporary.sqlite', 'report.json', 'temporary-report.json']);
    const rename = jest.fn((from: string, to: string) => {
      if (from === 'temporary-report.json' && to === 'report.json') throw new Error('report publish failed');
      if (!files.delete(from)) throw new Error(`missing ${from}`);
      files.add(to);
    });

    expect(() => publishMigrationArtifacts(
      'temporary.sqlite', 'target.sqlite', 'target.backup',
      'temporary-report.json', 'report.json', 'report.backup',
      { exists: (path) => files.has(path), rename },
    )).toThrow('report publish failed');

    expect(rename.mock.calls).toEqual([
      ['report.json', 'report.backup'],
      ['temporary-report.json', 'report.json'],
      ['report.backup', 'report.json'],
    ]);
    expect(files.has('target.sqlite')).toBe(true);
    expect(files.has('temporary.sqlite')).toBe(true);
    expect(files.has('report.json')).toBe(true);
    expect(files.has('temporary-report.json')).toBe(true);
  });
});
