import { MigrationInterface, QueryRunner } from 'typeorm';

export class MakeTelegramFilePathNullable1781000000000 implements MigrationInterface {
  name = 'MakeTelegramFilePathNullable1781000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "files" ALTER COLUMN "telegramFilePath" DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 将 NULL 值替换为空字符串再恢复 NOT NULL
    await queryRunner.query(`UPDATE "files" SET "telegramFilePath" = '' WHERE "telegramFilePath" IS NULL`);
    await queryRunner.query(`ALTER TABLE "files" ALTER COLUMN "telegramFilePath" SET NOT NULL`);
  }
}
