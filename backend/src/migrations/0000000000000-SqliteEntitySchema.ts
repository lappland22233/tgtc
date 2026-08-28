import { MigrationInterface, QueryRunner, Table, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

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
    for (const metadata of metadatas) {
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
          isUnique: (column as unknown as EntityColumnMetadata).isUnique,
          isGenerated: false,
          default: sqliteColumnDefault(column),
        })),
      }), true);
    }
    for (const metadata of metadatas) {
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
        await queryRunner.createIndex(metadata.tableName, new TableIndex({
          name: index.name,
          columnNames: index.columns.map((column) => typeof column === 'string' ? column : column.databaseName),
          isUnique: index.isUnique,
        }));
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    for (const metadata of [...queryRunner.connection.entityMetadatas].reverse()) {
      if (await queryRunner.hasTable(metadata.tableName)) await queryRunner.dropTable(metadata.tableName, true);
    }
  }
}
