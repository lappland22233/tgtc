import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G8-13：file_access_logs 增加 (action, createdAt) 索引。
 *
 * 背景：
 * - file_access_logs 表用于异常下载/分享检测与文件访问审计，查询常按
 *   action + createdAt 时间窗口扫描（如 detectAbnormalDownloads / detectAbnormalSharing）。
 * - 表随访问量持续增长，缺该索引时窗口扫描退化为全表扫描；
 *   同时该表已纳入 archive-data 定期清理（见 other.processors.ts），
 *   建索引让归档清理同样受益。
 */
export class AddFileAccessLogActionCreatedIndex1798100000000 implements MigrationInterface {
  name = 'AddFileAccessLogActionCreatedIndex1798100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_access_logs_action_created"
       ON "file_access_logs" ("action", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_access_logs_action_created"`);
  }
}
