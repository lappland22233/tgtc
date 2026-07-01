import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUploadTaskAndDeletionFields1787000000000 implements MigrationInterface {
  name = 'AddUploadTaskAndDeletionFields1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 创建 upload_tasks 表
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "upload_tasks" (
        "jobId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "filename" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "progress" integer NOT NULL DEFAULT 0,
        "result" text,
        "error" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_upload_tasks_jobId" PRIMARY KEY ("jobId")
      )
    `);

    // files 表添加延迟删除相关字段
    await queryRunner.query(`
      ALTER TABLE "files"
      ADD COLUMN IF NOT EXISTS "deleteRequestedAt" TIMESTAMP
    `);
    await queryRunner.query(`
      ALTER TABLE "files"
      ADD COLUMN IF NOT EXISTS "deleteScheduledAt" TIMESTAMP
    `);
    await queryRunner.query(`
      ALTER TABLE "files"
      ADD COLUMN IF NOT EXISTS "deleteCooldownUntil" TIMESTAMP
    `);
    await queryRunner.query(`
      ALTER TABLE "files"
      ADD COLUMN IF NOT EXISTS "deletedByAdmin" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "deletedByAdmin"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "deleteCooldownUntil"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "deleteScheduledAt"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "deleteRequestedAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "upload_tasks"`);
  }
}
