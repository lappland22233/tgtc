import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTelemetryRecordsTable1790300000000 implements MigrationInterface {
  name = 'CreateTelemetryRecordsTable1790300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telemetry_records" (
        "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        "type" VARCHAR(20) NOT NULL,
        "data" JSONB NOT NULL,
        "ip" VARCHAR NOT NULL,
        "userId" UUID,
        "userAgent" VARCHAR(500),
        "clientTimestamp" BIGINT,
        "createdAt" TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_telemetry_records_createdAt" ON "telemetry_records" ("createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_telemetry_records_type" ON "telemetry_records" ("type")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_telemetry_records_userId" ON "telemetry_records" ("userId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_telemetry_records_userId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_telemetry_records_type"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_telemetry_records_createdAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telemetry_records"`);
  }
}
