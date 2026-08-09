import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFileUploadStateMachine1791200000000 implements MigrationInterface {
  name = 'AddFileUploadStateMachine1791200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "uploadVersion" integer NOT NULL DEFAULT 1`);
    await queryRunner.query(`ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "uploadStage" varchar(32) NOT NULL DEFAULT 'committed'`);
    await queryRunner.query(`UPDATE "files" SET "uploadStage" = CASE WHEN "status" = 'processing' THEN 'pending' WHEN "status" = 'error' THEN 'failed' ELSE 'committed' END`);
    await queryRunner.query(`ALTER TABLE "files" ADD CONSTRAINT "CHK_files_upload_stage" CHECK ("uploadStage" IN ('pending', 'uploading', 'remote_committed', 'committed', 'failed'))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "CHK_files_upload_stage"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "uploadStage"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "uploadVersion"`);
  }
}
