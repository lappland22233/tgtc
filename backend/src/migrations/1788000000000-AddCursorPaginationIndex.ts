import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCursorPaginationIndex1788000000000 implements MigrationInterface {
    name = 'AddCursorPaginationIndex1788000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Composite index for cursor-based pagination: ORDER BY createdAt DESC, id DESC
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_files_createdAt_id_desc" ON "files" ("createdAt" DESC, "id" DESC)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_createdAt_id_desc"`);
    }

}
