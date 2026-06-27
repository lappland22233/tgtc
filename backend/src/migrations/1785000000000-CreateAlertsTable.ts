import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAlertsTable1785000000000 implements MigrationInterface {
  name = 'CreateAlertsTable1785000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "alerts" (
        "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        "ruleId" VARCHAR(100) NOT NULL,
        "level" VARCHAR(20) NOT NULL DEFAULT 'info',
        "title" VARCHAR(255) NOT NULL,
        "message" TEXT,
        "context" JSONB,
        "acknowledgedAt" TIMESTAMPTZ,
        "acknowledgedBy" UUID REFERENCES "users"("id") ON DELETE SET NULL,
        "createdAt" TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_alerts_ruleId_createdAt" ON "alerts" ("ruleId", "createdAt" DESC)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_alerts_acknowledged" ON "alerts" ("acknowledgedAt") WHERE "acknowledgedAt" IS NULL`
    );

    // 创建 baseline_stats 表（Phase 5 使用）
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "baseline_stats" (
        "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        "metricName" VARCHAR(100) NOT NULL,
        "hourBucket" INT NOT NULL,
        "dayOfWeek" INT NOT NULL,
        "mean" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "stddev" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "sampleCount" INT NOT NULL DEFAULT 0,
        "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE("metricName", "hourBucket", "dayOfWeek")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "baseline_stats"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_alerts_acknowledged"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_alerts_ruleId_createdAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "alerts"`);
  }
}
