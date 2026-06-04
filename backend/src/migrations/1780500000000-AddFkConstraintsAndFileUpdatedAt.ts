import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFkConstraintsAndFileUpdatedAt1780500000000 implements MigrationInterface {
  name = 'AddFkConstraintsAndFileUpdatedAt1780500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ===== 1. 添加 files.updatedAt 列 =====
    await queryRunner.query(`
      ALTER TABLE "files"
      ADD COLUMN IF NOT EXISTS "updatedAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_files_updatedAt" ON "files"("updatedAt")`);

    // 将现有行的 updatedAt 设为 createdAt（已有数据回溯）
    await queryRunner.query(`UPDATE "files" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL`);

    // ===== 2. 重建外键约束（添加级联策略） =====

    // 2a. share_audits: 文件删除时级联删除分享审计记录
    await queryRunner.query(`ALTER TABLE "share_audits" DROP CONSTRAINT IF EXISTS "fk_share_audits_file"`);
    await queryRunner.query(`
      ALTER TABLE "share_audits"
      ADD CONSTRAINT "fk_share_audits_file"
      FOREIGN KEY ("fileId") REFERENCES "files"("id")
      ON DELETE CASCADE
    `);

    // 2b. file_access_logs: 文件删除时级联删除访问日志
    await queryRunner.query(`ALTER TABLE "file_access_logs" DROP CONSTRAINT IF EXISTS "fk_file_access_logs_file"`);
    await queryRunner.query(`
      ALTER TABLE "file_access_logs"
      ADD CONSTRAINT "fk_file_access_logs_file"
      FOREIGN KEY ("fileId") REFERENCES "files"("id")
      ON DELETE CASCADE
    `);

    // 注意：files.uploaderId → users.id 不添加 CASCADE。
    // 用户删除时由应用层做软删除（isDeleted=true），保持数据可追溯。
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 回滚 files.updatedAt
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_updatedAt"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "updatedAt"`);

    // 回滚级联外键（恢复为无 CASCADE 的原始约束）
    await queryRunner.query(`ALTER TABLE "share_audits" DROP CONSTRAINT IF EXISTS "fk_share_audits_file"`);
    await queryRunner.query(`
      ALTER TABLE "share_audits"
      ADD CONSTRAINT "fk_share_audits_file"
      FOREIGN KEY ("fileId") REFERENCES "files"("id")
    `);

    await queryRunner.query(`ALTER TABLE "file_access_logs" DROP CONSTRAINT IF EXISTS "fk_file_access_logs_file"`);
    await queryRunner.query(`
      ALTER TABLE "file_access_logs"
      ADD CONSTRAINT "fk_file_access_logs_file"
      FOREIGN KEY ("fileId") REFERENCES "files"("id")
    `);
  }
}
