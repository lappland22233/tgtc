import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRateLimitsTable1704800000000 implements MigrationInterface {
  name = 'AddRateLimitsTable1704800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "rate_limits" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "key" varchar NOT NULL UNIQUE,
        "type" varchar NOT NULL,
        "attemptCount" integer NOT NULL DEFAULT 1,
        "firstAttemptAt" timestamp NOT NULL DEFAULT now(),
        "lockedUntil" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`CREATE INDEX "idx_rate_limits_key" ON "rate_limits"("key")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "rate_limits"`);
  }
}
