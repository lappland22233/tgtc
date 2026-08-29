"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteSchemaAlignment1800000000000 = void 0;
const typeorm_1 = require("typeorm");
/**
 * SQLite 版本化增量迁移。
 *
 * 基线迁移之后的旧 SQLite 库不能再次依赖 synchronize 或重建整库；本迁移只
 * 向前补齐实体中缺失的列和索引，并修复闭包表名称。所有操作均幂等，保留
 * 未被实体使用的旧表/列，便于旧库安全升级和备份恢复。
 */
class SqliteSchemaAlignment1800000000000 {
    constructor() {
        this.name = 'SqliteSchemaAlignment1800000000000';
    }
    async up(queryRunner) {
        if (queryRunner.connection.options.type !== 'sqlite')
            return;
        for (const metadata of queryRunner.connection.entityMetadatas) {
            if (!(await queryRunner.hasTable(metadata.tableName)))
                continue;
            const table = await queryRunner.getTable(metadata.tableName);
            if (!table)
                continue;
            for (const column of metadata.columns) {
                if (table.findColumnByName(column.databaseName))
                    continue;
                // SQLite 不能给已有行新增无默认值的 NOT NULL 列；这类列只能由专门的
                // 数据迁移先回填后再收紧约束，避免升级时隐式丢数据或填入错误值。
                const canAddToPopulatedTable = column.isNullable || column.default !== undefined;
                if (!canAddToPopulatedTable) {
                    const countRows = await queryRunner.query(`SELECT COUNT(*) AS "count" FROM "${metadata.tableName.replace(/"/g, '""')}"`);
                    if (Number(countRows[0]?.count || 0) > 0) {
                        throw new Error(`SQLite 增量迁移无法安全新增非空无默认列 ${metadata.tableName}.${column.databaseName}：表中已有数据；请编写专用迁移先回填再收紧约束`);
                    }
                }
                await queryRunner.addColumn(metadata.tableName, new typeorm_1.TableColumn({
                    name: column.databaseName,
                    type: sqliteColumnType(column.type),
                    length: /^\d+$/.test(column.length || '') ? column.length : undefined,
                    isNullable: column.isNullable,
                    default: sqliteColumnDefault(column.default),
                }));
            }
            const uniqueDefinitions = [
                ...metadata.uniques.map((unique) => ({
                    name: unique.name,
                    columns: unique.columns.map((column) => column.databaseName),
                })),
                ...metadata.columns
                    .filter((column) => column.isUnique)
                    .map((column) => ({ name: `uq_${metadata.tableName}_${column.databaseName}`, columns: [column.databaseName] })),
            ];
            for (const unique of uniqueDefinitions) {
                if (!unique.columns.length)
                    continue;
                const current = await queryRunner.getTable(metadata.tableName);
                if (!current)
                    continue;
                const sameColumns = (columns) => columns.join('\0') === unique.columns.join('\0');
                const alreadyPresent = current.uniques.some((item) => sameColumns(item.columnNames))
                    || current.indices.some((item) => item.isUnique && !item.where && sameColumns(item.columnNames));
                if (alreadyPresent)
                    continue;
                const quotedColumns = unique.columns.map((column) => `"${column.replace(/"/g, '""')}"`);
                const duplicates = await queryRunner.query(`SELECT ${quotedColumns.join(', ')}, COUNT(*) AS "duplicateCount"
           FROM "${metadata.tableName.replace(/"/g, '""')}"
           WHERE ${quotedColumns.map((column) => `${column} IS NOT NULL`).join(' AND ')}
           GROUP BY ${quotedColumns.join(', ')} HAVING COUNT(*) > 1 LIMIT 5`);
                if (duplicates.length) {
                    throw new Error(`SQLite 增量迁移无法补齐唯一约束 ${metadata.tableName}(${unique.columns.join(', ')}): `
                        + `升级前检测到重复数据 ${JSON.stringify(duplicates)}`);
                }
                await queryRunner.createUniqueConstraint(metadata.tableName, new typeorm_1.TableUnique({
                    name: unique.name,
                    columnNames: unique.columns,
                }));
            }
            const refreshed = await queryRunner.getTable(metadata.tableName);
            if (!refreshed)
                continue;
            for (const index of metadata.indices) {
                if (index.synchronize === false || !index.columns.length)
                    continue;
                if (refreshed.indices.some((existing) => existing.name === index.name))
                    continue;
                await queryRunner.createIndex(metadata.tableName, new typeorm_1.TableIndex({
                    name: index.name,
                    columnNames: index.columns.map((column) => typeof column === 'string' ? column : column.databaseName),
                    isUnique: index.isUnique,
                    where: index.where,
                }));
            }
        }
        // SQLite 唯一索引把 NULL 视为互不相等；用稳定哨兵合并根目录 parentId=NULL，
        // 才能真正保证同一用户根目录下活动文件夹名称唯一。
        if (await queryRunner.hasTable('folders')) {
            const duplicates = await queryRunner.query(`
        SELECT "ownerId", COALESCE("parentId", '') AS "normalizedParentId", "name", COUNT(*) AS "duplicateCount"
        FROM "folders" WHERE "isDeleted" = false
        GROUP BY "ownerId", COALESCE("parentId", ''), "name"
        HAVING COUNT(*) > 1 LIMIT 5
      `);
            if (duplicates.length) {
                throw new Error('SQLite 增量迁移无法补齐唯一索引 folders(ownerId, COALESCE(parentId, \'\'), name) WHERE isDeleted=false: '
                    + `升级前检测到同层活动文件夹重名 ${JSON.stringify(duplicates)}`);
            }
            await queryRunner.query('DROP INDEX IF EXISTS "uq_folders_owner_parent_name_active"');
            await queryRunner.query(`CREATE UNIQUE INDEX "uq_folders_owner_parent_name_active"
        ON "folders" ("ownerId", COALESCE("parentId", ''), "name")
        WHERE "isDeleted" = false`);
        }
        // @Tree('closure-table', { closureTableName: 'folder' }) 的正式名称必须稳定。
        if (await queryRunner.hasTable('folders') && !(await queryRunner.hasTable('folder_closure'))) {
            await queryRunner.createTable(new typeorm_1.Table({
                name: 'folder_closure',
                columns: [
                    { name: 'id_ancestor', type: 'varchar', isPrimary: true },
                    { name: 'id_descendant', type: 'varchar', isPrimary: true },
                ],
                foreignKeys: [
                    new typeorm_1.TableForeignKey({
                        name: 'FK_closure_ancestor',
                        columnNames: ['id_ancestor'],
                        referencedTableName: 'folders',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    }),
                    new typeorm_1.TableForeignKey({
                        name: 'FK_closure_descendant',
                        columnNames: ['id_descendant'],
                        referencedTableName: 'folders',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    }),
                ],
            }), true);
        }
        if (await queryRunner.hasTable('folder_closure')) {
            // parentId 是存量层级关系的权威来源。无论闭包表刚创建还是旧表不完整，
            // 都幂等补齐每个文件夹的自环及全部祖先关系。
            await queryRunner.query(`
        INSERT OR IGNORE INTO "folder_closure" ("id_ancestor", "id_descendant")
        WITH RECURSIVE pairs("id_ancestor", "id_descendant", "depth") AS (
          SELECT "id", "id", 0 FROM "folders"
          UNION ALL
          SELECT pairs."id_ancestor", folders."id", pairs."depth" + 1
          FROM "folders"
          JOIN pairs ON folders."parentId" = pairs."id_descendant"
          WHERE pairs."depth" < 25
        )
        SELECT DISTINCT "id_ancestor", "id_descendant" FROM pairs
      `);
            const table = await queryRunner.getTable('folder_closure');
            if (table && !table.indices.some((index) => index.name === 'IDX_closure_descendant')) {
                await queryRunner.createIndex('folder_closure', new typeorm_1.TableIndex({
                    name: 'IDX_closure_descendant',
                    columnNames: ['id_descendant'],
                }));
            }
        }
    }
    async down() {
        // 增量升级可能已补齐旧库结构；回退不得删除列、索引或业务数据。
        // 请使用备份恢复，或另行执行经过审查的前向修复迁移。
    }
}
exports.SqliteSchemaAlignment1800000000000 = SqliteSchemaAlignment1800000000000;
function sqliteColumnType(type) {
    if (type === String)
        return 'varchar';
    if (type === Number)
        return 'integer';
    if (type === Boolean)
        return 'boolean';
    if (type === Date || type === 'timestamp' || type === 'timestamptz' || type === 'datetime')
        return 'datetime';
    if (type === 'uuid' || type === 'enum' || type === 'jsonb' || type === 'simple-json')
        return 'varchar';
    if (type === 'bigint')
        return 'bigint';
    return typeof type === 'string' ? type : 'varchar';
}
function sqliteColumnDefault(value) {
    if (typeof value === 'boolean' || typeof value === 'number')
        return value;
    if (typeof value !== 'string')
        return undefined;
    if (/^\(?\s*(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)\s*\)?$/i.test(value))
        return value;
    return /^'.*'$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
}
