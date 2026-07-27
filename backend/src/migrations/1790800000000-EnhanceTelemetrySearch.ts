import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 扩展遥测错误类型长度，并为管理端按 IP、用户、类型 + 时间检索建立复合索引。
 */
export class EnhanceTelemetrySearch1790800000000 implements MigrationInterface {
  name = 'EnhanceTelemetrySearch1790800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "telemetry_records" ALTER COLUMN "type" TYPE VARCHAR(32)`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_telemetry_records_ip"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_telemetry_records_userId"`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_telemetry_records_ip_createdAt"
       ON "telemetry_records" ("ip", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_telemetry_records_userId_createdAt"
       ON "telemetry_records" ("userId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_telemetry_records_userId_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_telemetry_records_ip_createdAt"`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_telemetry_records_ip" ON "telemetry_records" ("ip")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_telemetry_records_userId" ON "telemetry_records" ("userId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "telemetry_records" ALTER COLUMN "type" TYPE VARCHAR(20)`,
    );
  }
}
