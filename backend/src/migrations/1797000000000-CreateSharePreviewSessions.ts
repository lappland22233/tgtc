import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSharePreviewSessions1797000000000 implements MigrationInterface {
  name = 'CreateSharePreviewSessions1797000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "share_preview_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "shareLinkId" uuid NOT NULL,
        "fileId" uuid NOT NULL,
        "visitorHash" char(64) NOT NULL,
        "consumed" boolean NOT NULL DEFAULT true,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "expiresAt" timestamp NOT NULL,
        CONSTRAINT "PK_share_preview_sessions_id" PRIMARY KEY ("id"),
        CONSTRAINT "uq_share_preview_sessions_link_file_visitor" UNIQUE ("shareLinkId", "fileId", "visitorHash")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_share_preview_sessions_expiresAt" ON "share_preview_sessions" ("expiresAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_share_preview_sessions_shareLinkId" ON "share_preview_sessions" ("shareLinkId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_share_preview_sessions_shareLinkId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_share_preview_sessions_expiresAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "share_preview_sessions"`);
  }
}
