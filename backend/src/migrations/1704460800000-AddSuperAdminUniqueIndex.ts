import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSuperAdminUniqueIndex1704460800000 implements MigrationInterface {
  name = 'AddSuperAdminUniqueIndex1704460800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 部分唯一索引：确保 super_admin 角色只有一个用户
    // PostgreSQL 支持 WHERE 条件索引，仅对 role = 'super_admin' 的行施加唯一约束
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_users_super_admin_unique"
      ON "users"("role")
      WHERE role = 'super_admin'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_super_admin_unique"`);
  }
}
