import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `files` 增加 `detectedExtension`（PostgreSQL）。
 *
 * mimeType 取自客户端 multipart 声明，可伪造。公开 /media 直链的内联白名单此前只读
 * mimeType，`isSafePublicInlineContentType` 的 detectedExtension 一致性参数全仓无人传值，
 * 宣称的「MIME/魔数不一致一律拒绝」是死防御。本列保存上传时的 magic bytes 探测结果。
 *
 * 存量行保持 NULL：一致性校验只在有探测结果时收紧，不改变既有文件的可用性。
 */
export class AddFileDetectedExtension1805200000000 implements MigrationInterface {
  name = 'AddFileDetectedExtension1805200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;

    await queryRunner.query(
      'ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "detectedExtension" varchar(16)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;

    await queryRunner.query('ALTER TABLE "files" DROP COLUMN IF EXISTS "detectedExtension"');
  }
}