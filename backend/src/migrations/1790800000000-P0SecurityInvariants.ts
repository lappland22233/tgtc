import { MigrationInterface, QueryRunner } from 'typeorm';

export class P0SecurityInvariants1790800000000 implements MigrationInterface {
  name = 'P0SecurityInvariants1790800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "jwt_revoked_tokens" (
        "jti" varchar(64) PRIMARY KEY,
        "userId" uuid NOT NULL,
        "expiresAt" timestamp NOT NULL,
        "revokedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_jwt_revoked_tokens_expiresAt" ON "jwt_revoked_tokens" ("expiresAt")`,
    );

    // 早期实体对齐迁移曾删除旧 unbannedAt，但当前实体使用独立的 unbanned_at 软解封列。
    await queryRunner.query(
      `ALTER TABLE "banned_ips" ADD COLUMN IF NOT EXISTS "unbanned_at" timestamp`,
    );

    // 历史非法临时封禁不能安全推断到期时间，标记为已解封后再施加不变量。
    await queryRunner.query(`
      UPDATE "banned_ips"
      SET "unbanned_at" = COALESCE("unbanned_at", NOW())
      WHERE "isPermanent" = false AND "expiresAt" IS NULL
    `);
    await queryRunner.query(`
      UPDATE "banned_ips"
      SET "expiresAt" = NULL
      WHERE "isPermanent" = true AND "expiresAt" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "banned_ips"
      ADD CONSTRAINT "CHK_banned_ips_permanence_expiry"
      CHECK (("isPermanent" = true AND "expiresAt" IS NULL)
          OR ("isPermanent" = false AND "expiresAt" IS NOT NULL))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "banned_ips" DROP CONSTRAINT IF EXISTS "CHK_banned_ips_permanence_expiry"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_jwt_revoked_tokens_expiresAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "jwt_revoked_tokens"`);
  }
}
