import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJtiUniqueConstraint1790100000000 implements MigrationInterface {
  name = 'AddJtiUniqueConstraint1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Remove any duplicate jti entries first (keep the earliest)
    await queryRunner.query(`
      DELETE FROM "share_audits"
      WHERE "id" IN (
        SELECT "id" FROM (
          SELECT "id",
            ROW_NUMBER() OVER (PARTITION BY "jti" ORDER BY "createdAt" ASC) as rn
          FROM "share_audits"
        ) t WHERE t.rn > 1
      )
    `);
    await queryRunner.query(`ALTER TABLE "share_audits" ADD CONSTRAINT "UQ_share_audits_jti" UNIQUE ("jti")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "share_audits" DROP CONSTRAINT "UQ_share_audits_jti"`);
  }
}
