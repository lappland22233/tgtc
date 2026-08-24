import { MigrationInterface, QueryRunner } from 'typeorm';

/** 移除已下线的管理后台自定义仪表盘及其专属数据表。 */
export class DropDashboardConfigs1798200000000 implements MigrationInterface {
  name = 'DropDashboardConfigs1798200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "dashboard_configs"');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dashboard_configs" (
        "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "name" VARCHAR(100) NOT NULL DEFAULT '默认面板',
        "config" JSONB NOT NULL DEFAULT '[]',
        "isDefault" BOOLEAN DEFAULT false,
        "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
        "updatedAt" TIMESTAMP DEFAULT NOW() NOT NULL,
        UNIQUE("userId", "name")
      )
    `);
  }
}
