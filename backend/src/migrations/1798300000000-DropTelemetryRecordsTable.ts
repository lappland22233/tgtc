import { MigrationInterface, QueryRunner } from 'typeorm';

/** 安全移除已停用的前端遥测数据表；不修改历史迁移。 */
export class DropTelemetryRecordsTable1798300000000 implements MigrationInterface {
  name = 'DropTelemetryRecordsTable1798300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "telemetry_records"');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 回滚仅恢复后续历史迁移所依赖的结构，不恢复已删除的遥测数据。
    // 结构与 1790800000000-EnhanceTelemetrySearch 完成后的表保持一致。
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telemetry_records" (
        "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        "type" VARCHAR(32) NOT NULL,
        "data" JSONB NOT NULL,
        "ip" VARCHAR NOT NULL,
        "userId" UUID,
        "userAgent" VARCHAR(500),
        "clientTimestamp" BIGINT,
        "createdAt" TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_telemetry_records_createdAt" ON "telemetry_records" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_telemetry_records_type" ON "telemetry_records" ("type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_telemetry_records_ip_createdAt" ON "telemetry_records" ("ip", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_telemetry_records_userId_createdAt" ON "telemetry_records" ("userId", "createdAt")`,
    );
  }
}
