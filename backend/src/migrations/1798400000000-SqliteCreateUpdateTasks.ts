import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SQLite 增量迁移：为存量 SQLite 库补齐 update_tasks 表。
 *
 * 全新 SQLite 库由 0000000000000-SqliteEntitySchema 依据实体元数据建表，
 * 本迁移使用 IF NOT EXISTS 保持幂等；两套路径的最终结构一致。
 */
export class SqliteCreateUpdateTasks1798400000000 implements MigrationInterface {
  name = 'SqliteCreateUpdateTasks1798400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "update_tasks" (
        "taskId" varchar NOT NULL,
        "requestedBy" varchar NOT NULL,
        "currentVersion" varchar(32) NOT NULL,
        "targetVersion" varchar(32) NOT NULL,
        "releaseId" integer NOT NULL,
        "releaseTag" varchar(64) NOT NULL,
        "status" varchar(24) NOT NULL DEFAULT 'queued',
        "progress" integer NOT NULL DEFAULT 0,
        "isActive" boolean NOT NULL DEFAULT 1,
        "errorCode" varchar(64),
        "errorSummary" text,
        "rollbackStatus" varchar(24),
        "metadata" varchar,
        "startedAt" datetime,
        "finishedAt" datetime,
        "heartbeatAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        CONSTRAINT "PK_update_tasks_taskId" PRIMARY KEY ("taskId")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_update_tasks_createdAt" ON "update_tasks" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_update_tasks_active_slot" ON "update_tasks" ("isActive") WHERE "isActive" = 1`,
    );
  }

  public async down(): Promise<void> {
    // 存量库可能已有任务数据；回退不删表，使用备份恢复或前向修复迁移。
  }
}
