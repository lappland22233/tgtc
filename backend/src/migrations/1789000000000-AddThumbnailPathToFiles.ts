import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddThumbnailPathToFiles1789000000000 implements MigrationInterface {
    name = 'AddThumbnailPathToFiles1789000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn('files', new TableColumn({
            name: 'thumbnailPath',
            type: 'varchar',
            length: '512',
            isNullable: true,
            default: null,
        }));
        // 索引用于启动扫描：找到所有图片但无缩略图的记录
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "idx_files_thumbnail_missing" ON "files" ("id") WHERE "mimeType" LIKE 'image/%' AND "thumbnailPath" IS NULL AND "isDeleted" = false`
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_thumbnail_missing"`);
        await queryRunner.dropColumn('files', 'thumbnailPath');
    }
}
