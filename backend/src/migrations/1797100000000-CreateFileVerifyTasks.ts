import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFileVerifyTasks1797100000000 implements MigrationInterface {
  name = 'CreateFileVerifyTasks1797100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "file_verify_tasks" (
        "taskId" uuid NOT NULL,
        "createdBy" uuid NOT NULL,
        "mode" character varying(16) NOT NULL DEFAULT 'dry-run',
        "allReady" boolean NOT NULL DEFAULT false,
        "limit" integer NOT NULL DEFAULT 500,
        "concurrency" integer NOT NULL DEFAULT 4,
        "isActive" boolean NOT NULL DEFAULT true,
        "status" character varying(16) NOT NULL DEFAULT 'queued',
        "totalCandidates" integer NOT NULL DEFAULT 0,
        "processed" integer NOT NULL DEFAULT 0,
        "valid" integer NOT NULL DEFAULT 0,
        "invalid" integer NOT NULL DEFAULT 0,
        "emptyFileId" integer NOT NULL DEFAULT 0,
        "temporaryFailure" integer NOT NULL DEFAULT 0,
        "sizeMismatch" integer NOT NULL DEFAULT 0,
        "backfilled" integer NOT NULL DEFAULT 0,
        "markedError" integer NOT NULL DEFAULT 0,
        "errorSummary" text,
        "startedAt" timestamptz,
        "completedAt" timestamptz,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_file_verify_tasks_taskId" PRIMARY KEY ("taskId")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_file_verify_tasks_createdAt" ON "file_verify_tasks" ("createdAt")`,
    );
    // 活动槽位部分唯一索引：同一时间仅允许 1 个 isActive=true 的活动任务
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_file_verify_tasks_active_slot" ON "file_verify_tasks" ("isActive") WHERE "isActive" = true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_file_verify_tasks_active_slot"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_file_verify_tasks_createdAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "file_verify_tasks"`);
  }
}
