import { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase0Infrastructure1784000000000 implements MigrationInterface {
  name = 'Phase0Infrastructure1784000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. access_logs — 新增 userId 字段
    await queryRunner.query(
      `ALTER TABLE "access_logs" ADD COLUMN IF NOT EXISTS "userId" UUID REFERENCES "users"("id") ON DELETE SET NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_access_logs_userId_createdAt" ON "access_logs" ("userId", "createdAt" DESC)`
    );

    // 2. file_access_logs — 新增 responseSize 字段
    await queryRunner.query(
      `ALTER TABLE "file_access_logs" ADD COLUMN IF NOT EXISTS "responseSize" BIGINT DEFAULT 0`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_file_access_logs_responseSize" ON "file_access_logs" ("responseSize")`
    );

    // 3. 创建预聚合表 access_log_metrics_1min
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "access_log_metrics_1min" (
        "windowTime" TIMESTAMP NOT NULL PRIMARY KEY,
        "totalRequests" INT NOT NULL DEFAULT 0,
        "qpsAvg" FLOAT NOT NULL DEFAULT 0,
        "error5xxCount" INT NOT NULL DEFAULT 0,
        "error4xxCount" INT NOT NULL DEFAULT 0,
        "totalBandwidth" BIGINT NOT NULL DEFAULT 0,
        "p95Duration" FLOAT NOT NULL DEFAULT 0,
        "uniqueIps" INT NOT NULL DEFAULT 0
      )
    `);

    // 4. file_access_logs 查询优化索引
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_file_access_logs_fileId_action" ON "file_access_logs" ("fileId", "createdAt" DESC) WHERE "action" = 'download'`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_file_access_logs_action_createdAt" ON "file_access_logs" ("action", "createdAt" DESC)`
    );

    // 5. access_logs 补充复合索引（来源/用户/路径/错误分析）
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_access_logs_ip_createdAt" ON "access_logs" ("ip", "createdAt" DESC)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_access_logs_path_createdAt" ON "access_logs" ("path", "createdAt" DESC)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_access_logs_statusCode_createdAt" ON "access_logs" ("statusCode", "createdAt" DESC)`
    );

    // 6. 加速 P95/P99 延迟计算
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_access_logs_createdAt_duration" ON "access_logs" ("createdAt", "duration") WHERE "duration" > 0`
    );

    // 7. 创建 daily_active_users 预聚合表（Phase 3 使用，Phase 0 建表）
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "daily_active_users" (
        "date" DATE NOT NULL PRIMARY KEY,
        "dauCount" INT NOT NULL DEFAULT 0,
        "dauIps" INT NOT NULL DEFAULT 0,
        "newUsers" INT NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP DEFAULT NOW()
      )
    `);

    // 8. files 表索引（文件排行查询优化）
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_files_uploaderId_isDeleted" ON "files" ("uploaderId") WHERE "isDeleted" = false`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_files_isDeleted_mimeType" ON "files" ("isDeleted", "mimeType")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_files_isDeleted_mimeType"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_files_uploaderId_isDeleted"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "daily_active_users"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_access_logs_createdAt_duration"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_access_logs_statusCode_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_access_logs_path_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_access_logs_ip_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_file_access_logs_action_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_file_access_logs_fileId_action"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "access_log_metrics_1min"`);
    await queryRunner.query(`ALTER TABLE "file_access_logs" DROP COLUMN IF EXISTS "responseSize"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_file_access_logs_responseSize"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_access_logs_userId_createdAt"`);
    await queryRunner.query(`ALTER TABLE "access_logs" DROP COLUMN IF EXISTS "userId"`);
  }
}
