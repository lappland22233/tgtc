import { MigrationInterface, QueryRunner } from 'typeorm';

export class GDriveOAuthFlows1804500000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "gdrive_oauth_flows" (
      "stateHash" varchar(64) PRIMARY KEY NOT NULL,
      "bindingHash" varchar(64) NOT NULL,
      "expiresAt" bigint NOT NULL
    )`);
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_gdrive_oauth_flows_expires" ON "gdrive_oauth_flows" ("expiresAt")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;
    await queryRunner.query('DROP TABLE IF EXISTS "gdrive_oauth_flows"');
  }
}
