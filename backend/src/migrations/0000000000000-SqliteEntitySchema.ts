import { MigrationInterface, QueryRunner, Table, TableColumn, TableForeignKey, TableIndex, TableUnique } from 'typeorm';

type EntityColumnMetadata = {
  type: unknown;
  databaseName: string;
  length?: string;
  isPrimary: boolean;
  isNullable: boolean;
  isUnique?: boolean;
  default?: unknown;
};

function sqliteColumnType(column: EntityColumnMetadata): string {
  if (column.type === String) return 'varchar';
  if (column.type === Number) return 'integer';
  if (column.type === Boolean) return 'boolean';
  if (column.type === Date) return 'datetime';
  if (column.type === 'uuid' || column.type === 'enum' || column.type === 'jsonb' || column.type === 'simple-json') return 'varchar';
  if (column.type === 'timestamp' || column.type === 'timestamptz' || column.type === 'datetime') return 'datetime';
  if (column.type === 'bigint') return 'bigint';
  return typeof column.type === 'string' ? column.type : 'varchar';
}

function sqliteColumnDefault(column: EntityColumnMetadata): string | undefined {
  if (typeof column.default !== 'string' && typeof column.default !== 'number' && typeof column.default !== 'boolean') return undefined;
  if (typeof column.default === 'boolean') return column.default ? '1' : '0';
  if (typeof column.default === 'number') return String(column.default);
  if (/^\(?\s*(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)\s*\)?$/i.test(column.default)) return column.default;
  if (/^'.*'$/.test(column.default)) return column.default;
  return `'${column.default.replace(/'/g, "''")}'`;
}

/** SQLite 的可运行基线迁移：从实体元数据生成 DDL，但不调用 synchronize。 */
export class SqliteEntitySchema1700000000000 implements MigrationInterface {
  name = 'SqliteEntitySchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    const metadatas = queryRunner.connection.entityMetadatas;
    const partialUniqueColumns = new Set(
      metadatas.flatMap((metadata) => metadata.indices
        .filter((index) => index.isUnique && Boolean(index.where))
        .flatMap((index) => index.columns.map((column) => `${metadata.tableName}.${typeof column === 'string' ? column : column.databaseName}`))),
    );
    for (const metadata of metadatas) {
      // TypeORM 自动注册的 closure-junction metadata 不含外键定义；交由后续
      // SQLiteSchemaAlignment 以显式 DDL 创建，避免先占位成无外键闭包表。
      if (metadata.tableType === 'closure-junction') continue;
      if (await queryRunner.hasTable(metadata.tableName)) continue;
      await queryRunner.createTable(new Table({
        name: metadata.tableName,
        columns: metadata.columns.map((column) => new TableColumn({
          // SQLite schema 基线只使用实体公开的列元数据；转换见下方辅助函数。
          name: column.databaseName,
          type: sqliteColumnType(column),
          length: typeof column.length === 'string' && /^\\d+$/.test(column.length) ? column.length : undefined,
          isPrimary: column.isPrimary,
          isNullable: column.isNullable,
          isUnique: !partialUniqueColumns.has(`${metadata.tableName}.${column.databaseName}`)
            && (column as unknown as EntityColumnMetadata).isUnique,
          isGenerated: false,
          default: sqliteColumnDefault(column),
        })),
      }), true);
    }
    for (const metadata of metadatas) {
      for (const unique of metadata.uniques) {
        const table = await queryRunner.getTable(metadata.tableName);
        if (!table || table.uniques.some((existing) => existing.name === unique.name)) continue;
        await queryRunner.createUniqueConstraint(metadata.tableName, new TableUnique({
          name: unique.name,
          columnNames: unique.columns.map((column) => column.databaseName),
        }));
      }
      for (const relation of metadata.relations) {
        if (!relation.isManyToOne || !relation.joinColumns.length) continue;
        const join = relation.joinColumns[0];
        const target = relation.inverseEntityMetadata;
        const table = await queryRunner.getTable(metadata.tableName);
        if (!table || table.foreignKeys.some((key) => key.columnNames.includes(join.databaseName))) continue;
        await queryRunner.createForeignKey(metadata.tableName, new TableForeignKey({
          name: `fk_${metadata.tableName}_${join.databaseName}`,
          columnNames: [join.databaseName],
          referencedTableName: target.tableName,
          referencedColumnNames: [target.primaryColumns[0].databaseName],
          onDelete: relation.onDelete,
        }));
      }
      for (const index of metadata.indices) {
        if (index.synchronize === false || !index.columns.length) continue;
        const table = await queryRunner.getTable(metadata.tableName);
        if (!table || table.indices.some((existing) => existing.name === index.name)) continue;
        await queryRunner.createIndex(metadata.tableName, new TableIndex({
          name: index.name,
          columnNames: index.columns.map((column) => typeof column === 'string' ? column : column.databaseName),
          isUnique: index.isUnique,
          where: index.where,
        }));
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    // SQLite 基线可能已经承载业务数据；revert 不得静默删表或删数据。
    // 如需回退，请使用备份恢复，或编写经过审查的前向修复迁移。
  }
}
