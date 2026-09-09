import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 创建 API 密钥表（PostgreSQL）。
 *
 * - keyHash 唯一索引：认证按摘要 O(log n) 查找，明文密钥永不落库；
 * - userId 索引 + (userId, revokedAt) 复合索引：服务「我的密钥列表」查询；
 * - 不建外键：与 update_tasks 等近期表保持一致，用户采用软删除，
 *   避免 files.uploaderId 同类的外键删除阻碍问题。
 */
export class CreateApiKeys1801000000000 implements MigrationInterface {
  name = 'CreateApiKeys1801000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "api_keys" (
        "id" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "name" character varying(64) NOT NULL,
        "prefix" character varying(16) NOT NULL,
        "keyHash" character varying(64) NOT NULL,
        "lastUsedAt" timestamptz,
        "revokedAt" timestamptz,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_api_keys_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_api_keys_keyHash" ON "api_keys" ("keyHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_api_keys_userId" ON "api_keys" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_api_keys_userId_revokedAt" ON "api_keys" ("userId", "revokedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_api_keys_userId_revokedAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_api_keys_userId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_api_keys_keyHash"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "api_keys"`);
  }
}
