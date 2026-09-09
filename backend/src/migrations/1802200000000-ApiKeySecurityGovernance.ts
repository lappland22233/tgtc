import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * v1.2.6：API 密钥安全治理（PostgreSQL）。
 * - api_keys 增加可逆加密密文列（AES-256-GCM，供所有者重显）；
 * - 新增 api_key_ip_allowlist（每把密钥独立 IP 白名单）；
 * - 新增 api_key_usage_logs（使用审计，7 天留存由应用层定时清理）。
 */
export class ApiKeySecurityGovernance1802200000000 implements MigrationInterface {
  name = 'ApiKeySecurityGovernance1802200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(`
      ALTER TABLE "api_keys"
        ADD COLUMN IF NOT EXISTS "keyCipher" varchar(512),
        ADD COLUMN IF NOT EXISTS "cipherVersion" varchar(16)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "api_key_ip_allowlist" (
        "id"        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "apiKeyId"  uuid NOT NULL,
        "rule"      varchar(64) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_api_key_ip_allowlist_keyId"
      ON "api_key_ip_allowlist" ("apiKeyId")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "api_key_usage_logs" (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "apiKeyId"   uuid NOT NULL,
        "userId"     uuid NOT NULL,
        "method"     varchar(10) NOT NULL,
        "route"      varchar(255) NOT NULL,
        "result"     varchar(20) NOT NULL DEFAULT 'allowed',
        "statusCode" int,
        "ip"         varchar(64) NOT NULL,
        "createdAt"  TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_api_key_usage_logs_keyId_createdAt"
      ON "api_key_usage_logs" ("apiKeyId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_api_key_usage_logs_userId_createdAt"
      ON "api_key_usage_logs" ("userId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_api_key_usage_logs_createdAt"
      ON "api_key_usage_logs" ("createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`DROP TABLE IF EXISTS "api_key_usage_logs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "api_key_ip_allowlist"`);
    await queryRunner.query(`
      ALTER TABLE "api_keys"
        DROP COLUMN IF EXISTS "keyCipher",
        DROP COLUMN IF EXISTS "cipherVersion"
    `);
  }
}
