import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixBannedIpAndUploadTaskSchema1790700600000 implements MigrationInterface {
  name = 'FixBannedIpAndUploadTaskSchema1790700600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "banned_ips" ADD COLUMN IF NOT EXISTS "unbanned_at" timestamp`,
    );
    await queryRunner.query(
      `ALTER TABLE "upload_tasks" DROP CONSTRAINT IF EXISTS "ck_upload_tasks_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "upload_tasks" ADD CONSTRAINT "ck_upload_tasks_status" CHECK ("status" IN ('pending', 'uploading', 'completed', 'failed'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "upload_tasks" DROP CONSTRAINT IF EXISTS "ck_upload_tasks_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "banned_ips" DROP COLUMN IF EXISTS "unbanned_at"`,
    );
  }
}
