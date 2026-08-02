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
      CREATE INDEX IF NOT EXISTS "IDX_files_pending_deletion"
      ON "files" ("deleteScheduledAt", "id")
      WHERE "isDeleted" = true
        AND "deleteRequestedAt" IS NOT NULL
        AND "deleteScheduledAt" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_files_pending_deletion"');
    await queryRunner.query(
      'ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "CHK_files_deleted_state_complete"',
    );
  }
}
