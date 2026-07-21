import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 文件 / 分片上传 / 分享 / 文件夹模块静态审查修复：补齐缺失索引。
 *
 * 这些索引对应实体上新增的 @Index 声明，用于消除以下全表扫描：
 * - files (uploaderId, folderId, isDeleted)：按用户+文件夹列出文件
 * - folders (ownerId, parentId, isDeleted)：按用户+父级列出子文件夹
 * - share_links (creatorId)：listMyShares 按创建者过滤
 * - share_audits (createdAt)：jti 防重放表的时间范围清理
 * - upload_tasks (updatedAt)：按更新时间恢复/清理任务
 * - file_access_logs (uploaderId, createdAt) / (fileId, createdAt)：时间范围/上传者统计
 *
 * 全部使用 CREATE INDEX IF NOT EXISTS / DROP INDEX IF EXISTS，幂等可重入。
 */
export class FileShareFixes1790700100000 implements MigrationInterface {
  name = 'FileShareFixes1790700100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_files_uploader_folder_deleted" ON "files" ("uploaderId", "folderId", "isDeleted")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_folders_owner_parent_deleted" ON "folders" ("ownerId", "parentId", "isDeleted")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_share_links_creatorId" ON "share_links" ("creatorId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_share_audits_createdAt" ON "share_audits" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_upload_tasks_updatedAt" ON "upload_tasks" ("updatedAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_access_logs_uploader_created" ON "file_access_logs" ("uploaderId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_access_logs_file_created" ON "file_access_logs" ("fileId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_access_logs_file_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_access_logs_uploader_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_upload_tasks_updatedAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_share_audits_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_share_links_creatorId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_folders_owner_parent_deleted"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_uploader_folder_deleted"`);
  }
}
