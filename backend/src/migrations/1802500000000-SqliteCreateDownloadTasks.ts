import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 下载任务持久化表（SQLite）。
 * 全新库由 SQLite 基线按实体元数据建表；存量库基线不会重跑，这里幂等补齐。
 */
export class SqliteCreateDownloadTasks1802500000000 implements MigrationInterface {
  name = 'SqliteCreateDownloadTasks1802500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "download_tasks" (
        "id" varchar PRIMARY KEY NOT NULL,
        "ownerKey" varchar(128) NOT NULL,
        "fileId" varchar NOT NULL,
        "fileName" varchar(255),
        "status" varchar(16) NOT NULL,
        "queueReason" varchar(16),
        "errorCode" varchar(64),
        "expectedSize" bigint NOT NULL DEFAULT 0,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        "expiresAt" datetime NOT NULL
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
