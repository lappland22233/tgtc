import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDashboardConfigs1786000000000 implements MigrationInterface {
  name = 'CreateDashboardConfigs1786000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dashboard_configs" (
        "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "name" VARCHAR(100) NOT NULL DEFAULT '默认面板',
        "config" JSONB NOT NULL DEFAULT '{}',
        "isDefault" BOOLEAN DEFAULT false,
        "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
        "updatedAt" TIMESTAMP DEFAULT NOW() NOT NULL,
        UNIQUE("userId", "name")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "dashboard_configs"`);
  }
}
