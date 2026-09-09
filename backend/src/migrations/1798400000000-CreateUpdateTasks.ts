import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUpdateTasks1798400000000 implements MigrationInterface {
  name = 'CreateUpdateTasks1798400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "update_tasks" (
        "taskId" uuid NOT NULL,
        "requestedBy" uuid NOT NULL,
        "currentVersion" character varying(32) NOT NULL,
        "targetVersion" character varying(32) NOT NULL,
        "releaseId" integer NOT NULL,
        "releaseTag" character varying(64) NOT NULL,
        "status" character varying(24) NOT NULL DEFAULT 'queued',
        "progress" integer NOT NULL DEFAULT 0,
        "isActive" boolean NOT NULL DEFAULT true,
        "errorCode" character varying(64),
        "errorSummary" text,
        "rollbackStatus" character varying(24),
        "metadata" jsonb,
        "startedAt" timestamptz,
        "finishedAt" timestamptz,
        "heartbeatAt" timestamptz,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_update_tasks_taskId" PRIMARY KEY ("taskId")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_update_tasks_createdAt" ON "update_tasks" ("createdAt")`,
    );
    // 活动槽位部分唯一索引：同一时间全局仅允许 1 个 isActive=true 的非终态任务
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_update_tasks_active_slot" ON "update_tasks" ("isActive") WHERE "isActive" = true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_update_tasks_active_slot"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_update_tasks_createdAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "update_tasks"`);
  }
}
