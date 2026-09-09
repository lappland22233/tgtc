import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 创建 API 密钥表（SQLite 方言）。
 * 文件名含 "Sqlite" 以命中 SQLite 迁移 glob（见 database.config.ts）。
 */
export class SqliteCreateApiKeys1801000000000 implements MigrationInterface {
  name = 'SqliteCreateApiKeys1801000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "api_keys" (
        "id" varchar NOT NULL,
        "userId" varchar NOT NULL,
        "name" varchar(64) NOT NULL,
        "prefix" varchar(16) NOT NULL,
        "keyHash" varchar(64) NOT NULL,
        "lastUsedAt" datetime,
        "revokedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
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
    if (queryRunner.connection.options.type !== 'sqlite') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_api_keys_userId_revokedAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_api_keys_userId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_api_keys_keyHash"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "api_keys"`);
  }
}
