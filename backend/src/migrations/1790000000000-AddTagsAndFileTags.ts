import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class AddTagsAndFileTags1790000000000 implements MigrationInterface {
    name = 'AddTagsAndFileTags1790000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // 1. 创建 tags 表
        await queryRunner.createTable(new Table({
            name: 'tags',
            columns: [
                {
                    name: 'id',
                    type: 'uuid',
                    isPrimary: true,
                    default: 'gen_random_uuid()',
                },
                {
                    name: 'name',
                    type: 'varchar',
                    length: '50',
                    isNullable: false,
                },
                {
                    name: 'color',
                    type: 'varchar',
                    length: '7',
                    default: `'#0052d9'`,
                },
                {
                    name: 'userId',
                    type: 'uuid',
                    isNullable: false,
                },
                {
                    name: 'createdAt',
                    type: 'timestamp',
                    default: 'NOW()',
                },
            ],
        }), true);

        // 2. 创建 file_tags 关联表
        await queryRunner.createTable(new Table({
            name: 'file_tags',
            columns: [
                {
                    name: 'fileId',
                    type: 'uuid',
                    isNullable: false,
                },
                {
                    name: 'tagId',
                    type: 'uuid',
                    isNullable: false,
                },
            ],
        }), true);

        // 复合主键
        await queryRunner.query(`ALTER TABLE "file_tags" ADD PRIMARY KEY ("fileId", "tagId")`);

        // 3. 外键约束
        await queryRunner.createForeignKey('tags', new TableForeignKey({
            columnNames: ['userId'],
            referencedColumnNames: ['id'],
            referencedTableName: 'users',
            onDelete: 'CASCADE',
        }));

        await queryRunner.createForeignKey('file_tags', new TableForeignKey({
            columnNames: ['fileId'],
            referencedColumnNames: ['id'],
            referencedTableName: 'files',
            onDelete: 'CASCADE',
        }));

        await queryRunner.createForeignKey('file_tags', new TableForeignKey({
            columnNames: ['tagId'],
            referencedColumnNames: ['id'],
            referencedTableName: 'tags',
            onDelete: 'CASCADE',
        }));

        // 4. 索引
        await queryRunner.query(`CREATE INDEX "idx_file_tags_tagId" ON "file_tags" ("tagId")`);
        await queryRunner.query(`CREATE INDEX "idx_file_tags_fileId" ON "file_tags" ("fileId")`);

        // 5. 同一用户下标签名唯一
        await queryRunner.query(`ALTER TABLE "tags" ADD CONSTRAINT "UQ_tags_name_userId" UNIQUE ("name", "userId")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_file_tags_fileId"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_file_tags_tagId"`);
        await queryRunner.query(`ALTER TABLE "tags" DROP CONSTRAINT IF EXISTS "UQ_tags_name_userId"`);
        await queryRunner.dropTable('file_tags');
        await queryRunner.dropTable('tags');
    }
}
