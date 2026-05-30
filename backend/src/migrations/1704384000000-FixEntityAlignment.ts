import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixEntityAlignment1704384000000 implements MigrationInterface {
  name = 'FixEntityAlignment1704384000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. banned_ips：迁移 bannedAt/unbannedAt → expiresAt/createdAt
    // 先添加新列
    await queryRunner.query(`ALTER TABLE "banned_ips" ADD COLUMN "expiresAt" timestamp`);
    await queryRunner.query(`ALTER TABLE "banned_ips" ADD COLUMN "createdAt" timestamp NOT NULL DEFAULT now()`);

    // 迁移数据：bannedAt 作为 createdAt，unbannedAt 作为 expiresAt
    await queryRunner.query(`UPDATE "banned_ips" SET "createdAt" = "bannedAt", "expiresAt" = "unbannedAt"`);

    // 删除旧列
    await queryRunner.query(`ALTER TABLE "banned_ips" DROP COLUMN "bannedAt"`);
    await queryRunner.query(`ALTER TABLE "banned_ips" DROP COLUMN "unbannedAt"`);

    // 2. users：添加 updatedAt 列
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "updatedAt" timestamp NOT NULL DEFAULT now()`);

    // 3. system_configs：value 列从 varchar 改为 text
    await queryRunner.query(`ALTER TABLE "system_configs" ALTER COLUMN "value" TYPE text`);

    // 4. users.role：添加 CHECK 约束
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "ck_users_role" CHECK ("role" IN ('user', 'admin', 'super_admin'))`,
    );

    // 5. files.accessType：添加 CHECK 约束
    await queryRunner.query(
      `ALTER TABLE "files" ADD CONSTRAINT "ck_files_accessType" CHECK ("accessType" IN ('public', 'private'))`,
    );

    // 6. verification_codes.type：添加 CHECK 约束
    await queryRunner.query(
      `ALTER TABLE "verification_codes" ADD CONSTRAINT "ck_verification_codes_type" CHECK ("type" IN ('register', 'reset_password'))`,
    );

    // 7. share_audits 添加组合索引
    await queryRunner.query(
      `CREATE INDEX "idx_share_audits_jti_action" ON "share_audits"("jti", "action")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_share_audits_fileId_action" ON "share_audits"("fileId", "action")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_share_audits_createdAt" ON "share_audits"("createdAt")`,
    );

    // 8. files 添加常用查询索引
    await queryRunner.query(
      `CREATE INDEX "idx_files_isDeleted_createdAt" ON "files"("isDeleted", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_files_createdAt" ON "files"("createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 反向操作
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_isDeleted_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_share_audits_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_share_audits_fileId_action"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_share_audits_jti_action"`);

    await queryRunner.query(`ALTER TABLE "verification_codes" DROP CONSTRAINT IF EXISTS "ck_verification_codes_type"`);
    await queryRunner.query(`ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "ck_files_accessType"`);
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "ck_users_role"`);

    // system_configs.value 从 text 改回 varchar
    await queryRunner.query(`ALTER TABLE "system_configs" ALTER COLUMN "value" TYPE varchar`);

    // users 删除 updatedAt
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "updatedAt"`);

    // banned_ips 还原旧列
    await queryRunner.query(`ALTER TABLE "banned_ips" ADD COLUMN "bannedAt" timestamp NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "banned_ips" ADD COLUMN "unbannedAt" timestamp`);
    await queryRunner.query(`UPDATE "banned_ips" SET "bannedAt" = "createdAt", "unbannedAt" = "expiresAt"`);
    await queryRunner.query(`ALTER TABLE "banned_ips" DROP COLUMN "expiresAt"`);
    await queryRunner.query(`ALTER TABLE "banned_ips" DROP COLUMN "createdAt"`);
  }
}
