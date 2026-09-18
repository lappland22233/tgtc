import { readdirSync, readFileSync } from 'fs';
import * as path from 'path';

/**
 * 实体列类型跨方言守卫（PG 启动阻断回归防护）
 *
 * 背景（真实缺陷）：`@Column({ type: 'datetime' })` 是 SQLite 方言的类型名，
 * PostgreSQL 不支持。该校验发生在 TypeORM 的 `DataSource.initialize()` 阶段，
 * 因此不仅迁移跑不动，后端在 PG 上也会直接启动失败：
 *
 *   DataTypeNotSupportedError: Data type "datetime" in "DownloadTask.expiresAt"
 *   is not supported by "postgres" database.
 *
 * 本守卫完全离线（不建立任何数据库连接），两层防御：
 * 1) 元数据层：按 PostgreSQL 语境重新求值 `databaseColumnType()`，校验
 *    `databaseEntities` 中每一列的最终类型都在 PG 可接受集合内；
 * 2) 源码层：直接扫描实体源文件的 SQLite 专有类型字面量，覆盖「新增实体
 *    但忘记注册进 databaseEntities」的情况。
 */
describe('实体列类型跨方言守卫（PostgreSQL 启动安全）', () => {
  /**
   * PostgreSQL 驱动可接受的列类型（含 TypeORM 的跨方言逻辑类型）。
   * 注意：'datetime' 不在其中——它只对 SQLite 有效，写进实体即 PG 启动失败。
   */
  const POSTGRES_SAFE_TYPES = new Set([
    'bigint', 'boolean', 'bytea', 'char', 'character', 'character varying',
    'date', 'decimal', 'double', 'double precision', 'enum', 'float',
    'int', 'int2', 'int4', 'int8', 'integer', 'interval', 'json', 'jsonb',
    'numeric', 'real', 'simple-array', 'simple-json', 'smallint', 'text',
    'time', 'timestamp', 'timestamptz', 'timetz', 'uuid', 'varchar', 'varying character',
  ]);

  /** SQLite 支持但 PostgreSQL 不支持的字面量（写死即为阻断缺陷） */
  const SQLITE_ONLY_LITERALS = [
    'datetime', 'nvarchar', 'nvarchar2', 'nchar', 'clob', 'mediumint',
    'tinyint', 'unsigned big int',
  ];

  it('databaseEntities 的列类型在 PostgreSQL 语境下均受支持', () => {
    const offenders: string[] = [];
    let checkedColumns = 0;

    // 必须在 PostgreSQL 语境下重新加载实体：databaseColumnType 在装饰器求值
    // （模块导入）时读取 DB_TYPE，若测试机上 DB_TYPE=sqlite 会把 timestamptz
    // 求值成 datetime，从而对守卫本身产生假阳性。
    const originalDbType = process.env.DB_TYPE;
    process.env.DB_TYPE = 'postgres';
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getMetadataArgsStorage } = require('typeorm');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { databaseEntities } = require('./entities');
        const columns = getMetadataArgsStorage().columns as Array<{
          target: unknown;
          propertyName: string;
          options: { type?: unknown };
        }>;

        for (const entity of databaseEntities) {
          for (const column of columns.filter(item => item.target === entity)) {
            const type = column.options?.type;
            // 关系列/函数型类型（如 () => Entity）不参与校验
            if (typeof type !== 'string') continue;
            checkedColumns++;
            if (POSTGRES_SAFE_TYPES.has(type.toLowerCase())) continue;
            offenders.push(`${(entity as { name: string }).name}.${column.propertyName}: type: '${type}'`);
          }
        }
      });
    } finally {
      if (originalDbType === undefined) delete process.env.DB_TYPE;
      else process.env.DB_TYPE = originalDbType;
    }

    // 扫描失效保护：实体数量异常时直接失败，避免守卫静默通过
    expect(checkedColumns).toBeGreaterThan(50);
    if (offenders.length > 0) {
      throw new Error(
        '以下实体列使用了 PostgreSQL 不支持的列类型（PG 上会在 DataSource.initialize() 阶段直接失败，'
        + '迁移与后端启动双阻断）：\n'
        + offenders.map(item => `  - ${item}`).join('\n')
        + '\n请改用 databaseColumnType()（见 src/database/database-types.ts）。',
      );
    }
  });

  it('TypeORM 的 PostgreSQL 驱动判定全部实体列类型受支持', () => {
    // 生产事故来自 TypeORM EntityMetadataValidator（DataSource.initialize() 内）：
    //   const normalized = driver.normalizeType(column);
    //   if (!driver.supportedDataTypes.includes(normalized))
    //     throw new DataTypeNotSupportedError(column, normalized, driver.options.type);
    // 这里逐字复刻该判定，避免"白名单写漏/写错"导致守卫失真。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PostgresDriver } = require('typeorm/driver/postgres/PostgresDriver');
    // 只需要 options.type 参与报错文案；不建立任何数据库连接
    const driver = new PostgresDriver({ options: { type: 'postgres' } });
    const isSupported = (type: string): boolean => {
      const normalized = driver.normalizeType({ type } as never);
      return driver.supportedDataTypes.includes(normalized);
    };

    const offenders: string[] = [];
    let checked = 0;
    const originalDbType = process.env.DB_TYPE;
    process.env.DB_TYPE = 'postgres';
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getMetadataArgsStorage } = require('typeorm');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { databaseEntities } = require('./entities');
        const columns = getMetadataArgsStorage().columns as Array<{
          target: unknown;
          propertyName: string;
          options: { type?: unknown };
        }>;

        for (const entity of databaseEntities) {
          for (const column of columns.filter(item => item.target === entity)) {
            const type = column.options?.type;
            if (typeof type !== 'string') continue;
            checked++;
            if (isSupported(type)) continue;
            offenders.push(
              `${(entity as { name: string }).name}.${column.propertyName}: type: '${type}'`,
            );
          }
        }
      });
    } finally {
      if (originalDbType === undefined) delete process.env.DB_TYPE;
      else process.env.DB_TYPE = originalDbType;
    }

    expect(checked).toBeGreaterThan(50);
    if (offenders.length > 0) {
      throw new Error(
        '以下实体列在 PostgreSQL 驱动归一化阶段直接失败（后端与迁移在 PG 上均无法启动）：\n'
        + offenders.map(item => `  - ${item}`).join('\n')
        + '\n请改用 databaseColumnType()（见 src/database/database-types.ts）。',
      );
    }
  });

  it('实体源码中不出现 SQLite 专有类型字面量', () => {
    const entitiesDir = path.join(__dirname, '..', 'common', 'entities');
    const files = readdirSync(entitiesDir).filter(file => file.endsWith('.entity.ts'));
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    const literalPattern = new RegExp(
      `type:\\s*['"](${SQLITE_ONLY_LITERALS.join('|')})['"]`,
      'g',
    );
    for (const file of files) {
      const source = readFileSync(path.join(entitiesDir, file), 'utf8');
      for (const match of source.matchAll(literalPattern)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        '以下实体列直接写入了 SQLite 专有类型字面量（PostgreSQL 不支持）：\n'
        + offenders.map(item => `  - ${item}`).join('\n')
        + '\n请改用 databaseColumnType()（见 src/database/database-types.ts）。',
      );
    }
  });
});
