import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * v1.2.6：API 密钥安全治理（SQLite 方言）。
 * 全新库的新表（api_key_ip_allowlist / api_key_usage_logs）由 SQLite 基线按实体元数据创建；
 * 存量库基线已执行不会重跑，本迁移使用 CREATE TABLE IF NOT EXISTS 补齐两表及索引，
 * 并为已存在的 api_keys 补充密文列（幂等执行）。
 */
export class SqliteApiKeySecurityGovernance1802200000000 implements MigrationInterface {
  name = 'SqliteApiKeySecurityGovernance1802200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;

    // 存量库基线已执行不会重跑，必须在此补齐两张治理表（对全新库幂等）。
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "api_key_ip_allowlist" (
        "id" varchar PRIMARY KEY NOT NULL,
        "apiKeyId" varchar NOT NULL,
        "rule" varchar(64) NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_api_key_ip_allowlist_keyId"
      ON "api_key_ip_allowlist" ("apiKeyId")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "api_key_usage_logs" (
        "id" varchar PRIMARY KEY NOT NULL,
        "apiKeyId" varchar NOT NULL,
        "userId" varchar NOT NULL,
        "method" varchar(10) NOT NULL,
        "route" varchar(255) NOT NULL,
        "result" varchar(20) NOT NULL DEFAULT 'allowed',
        "statusCode" integer,
        "ip" varchar(64) NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
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

    const table = await queryRunner.getTable('api_keys');
    if (table && !table.columns.some((c) => c.name === 'keyCipher')) {
      await queryRunner.query(`ALTER TABLE "api_keys" ADD COLUMN "keyCipher" varchar`);
    }
    if (table && !table.columns.some((c) => c.name === 'cipherVersion')) {
      await queryRunner.query(`ALTER TABLE "api_keys" ADD COLUMN "cipherVersion" varchar`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    // SQLite 不支持 DROP COLUMN（旧版）；保留列即可，无数据风险。
  }
}
