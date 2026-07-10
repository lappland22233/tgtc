import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFileStatusColumn1790200000000 implements MigrationInterface {
  name = 'AddFileStatusColumn1790200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "status" VARCHAR DEFAULT 'ready' NOT NULL`);
    await queryRunner.query(`ALTER TABLE "files" ADD CONSTRAINT "CK_files_status" CHECK ("status" IN ('processing', 'ready', 'error'))`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_files_status" ON "files" ("status")`);
    await queryRunner.query(`UPDATE "files" SET "status" = 'ready' WHERE "status" IS NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_files_status"`);
    await queryRunner.query(`ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "CK_files_status"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "status"`);
  }
}
