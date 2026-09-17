import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 下载任务持久化表（PostgreSQL）。
 *
 * 约定：手写迁移建表必须给 uuid 主键显式 DEFAULT gen_random_uuid()
 * （UuidSubscriber 只在 SQLite 分支注册），否则 PG 下漏写默认值会让整表写入报 23502。
 */
export class CreateDownloadTasks1802500000000 implements MigrationInterface {
  name = 'CreateDownloadTasks1802500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "download_tasks" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "ownerKey" character varying(128) NOT NULL,
        "fileId" uuid NOT NULL,
        "fileName" character varying(255),
        "status" character varying(16) NOT NULL,
        "queueReason" character varying(16),
        "errorCode" character varying(64),
        "expectedSize" bigint NOT NULL DEFAULT 0,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        -- 与实体 databaseColumnType('timestamptz') 对齐（CreateDateColumn/UpdateDateColumn 用 timestamp）
        "expiresAt" timestamptz NOT NULL,
        CONSTRAINT "PK_download_tasks_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_download_tasks_owner" ON "download_tasks" ("ownerKey")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_download_tasks_file" ON "download_tasks" ("fileId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_download_tasks_status" ON "download_tasks" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_download_tasks_expires" ON "download_tasks" ("expiresAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "download_tasks"`);
  }
}
