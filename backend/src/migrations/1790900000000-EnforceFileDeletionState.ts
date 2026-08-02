import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnforceFileDeletionState1790900000000 implements MigrationInterface {
  name = 'EnforceFileDeletionState1790900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "files"
      ADD CONSTRAINT "CHK_files_deleted_state_complete"
      CHECK (
        "isDeleted" = false
        OR ("deleteRequestedAt" IS NOT NULL AND "deleteScheduledAt" IS NOT NULL)
      ) NOT VALID
    `);
    await queryRunner.query(`
      ALTER TABLE "folders"
      ADD CONSTRAINT "CHK_folders_deleted_state_complete"
      CHECK (
        "isDeleted" = false
        OR ("deleteRequestedAt" IS NOT NULL AND "deleteScheduledAt" IS NOT NULL)
      ) NOT VALID
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "folders"
      DROP CONSTRAINT IF EXISTS "CHK_folders_deleted_state_complete"
    `);
    await queryRunner.query(`
      ALTER TABLE "files"
      DROP CONSTRAINT IF EXISTS "CHK_files_deleted_state_complete"
    `);
  }
}
