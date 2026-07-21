import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 认证与安全模块修复配套 schema 变更：
 * 1. rate_limits 补充 lockedUntil / updatedAt 索引（加速清理过期记录的定时查询）。
 * 2. verification_codes 复合索引扩展覆盖 expiresAt（匹配原子验证码校验查询的过滤条件）。
 * 3. 移除 verification_codes 死代码列 attempts（限流已由 rate_limits 统一承担，该列从未被读写）。
 *
 * 全部使用 IF EXISTS / IF NOT EXISTS 保证幂等，避免在部分已生效环境重跑报错。
 */
export class AuthSecurityFixes1790700000000 implements MigrationInterface {
  name = 'AuthSecurityFixes1790700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. rate_limits — 清理查询按 lockedUntil / updatedAt 过滤，补充专用索引
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_rate_limits_lockedUntil" ON "rate_limits" ("lockedUntil")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_rate_limits_updatedAt" ON "rate_limits" ("updatedAt")`,
    );

    // 2. verification_codes — 用覆盖 expiresAt 的复合索引替换原 3 列索引
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_verification_codes_email_type_isUsed_expiresAt"
       ON "verification_codes" ("email", "type", "isUsed", "expiresAt")`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_verification_codes_email_type_isUsed"`,
    );

    // 3. verification_codes — 移除死代码列 attempts
    await queryRunner.query(
      `ALTER TABLE "verification_codes" DROP COLUMN IF EXISTS "attempts"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 3. 恢复 attempts 列
    await queryRunner.query(
      `ALTER TABLE "verification_codes" ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0`,
    );

    // 2. 恢复原 3 列索引，移除扩展索引
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_verification_codes_email_type_isUsed"
       ON "verification_codes" ("email", "type", "isUsed")`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_verification_codes_email_type_isUsed_expiresAt"`,
    );

    // 1. 移除 rate_limits 索引
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rate_limits_updatedAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rate_limits_lockedUntil"`);
  }
}
