import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * v1.2.6：API 密钥安全治理（SQLite 方言）。
 * 新表（api_key_ip_allowlist / api_key_usage_logs）由 SQLite 基线按实体元数据创建，
 * 本迁移负责为已存在的 api_keys 补充密文列（ALTER TABLE ADD COLUMN 对既有库幂等执行）。
 */
export class SqliteApiKeySecurityGovernance1802200000000 implements MigrationInterface {
  name = 'SqliteApiKeySecurityGovernance1802200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;

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
