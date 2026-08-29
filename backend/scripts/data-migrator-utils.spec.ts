import {
  beginPostgresReadOnlySnapshot,
  publishMigratedFile,
  publishMigrationArtifacts,
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
