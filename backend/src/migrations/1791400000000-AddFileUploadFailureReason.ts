import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFileUploadFailureReason1791400000000 implements MigrationInterface {
  name = 'AddFileUploadFailureReason1791400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 新增内部诊断字段：最终上传失败的安全原因（脱敏、限长），不回填历史失败记录。
    await queryRunner.query(`ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "uploadFailureReason" varchar(1000) NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "uploadFailureReason"`);
  }
}
