import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `files` 增加 `overwriteSnapshot`（PostgreSQL）。
 *
 * 覆盖上传会先把 telegramFileId/filename 置为 tempId 占位，新内容上传失败时
 * 旧实现只置 status=error，无任何路径恢复旧引用 —— 原文件永久不可下载。
 * 该列保存覆盖前的内容引用快照，供失败路径原子回滚。
 */
export class AddFileOverwriteSnapshot1805100000000 implements MigrationInterface {
  name = 'AddFileOverwriteSnapshot1805100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;

    await queryRunner.query(
      'ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "overwriteSnapshot" text',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;

    await queryRunner.query('ALTER TABLE "files" DROP COLUMN IF EXISTS "overwriteSnapshot"');
  }
}