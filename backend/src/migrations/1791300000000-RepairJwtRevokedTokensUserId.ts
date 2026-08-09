import { MigrationInterface, QueryRunner } from 'typeorm';

export class RepairJwtRevokedTokensUserId1791300000000 implements MigrationInterface {
  name = 'RepairJwtRevokedTokensUserId1791300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tableExists = await queryRunner.hasTable('jwt_revoked_tokens');
    if (!tableExists) {
      return;
    }

    await queryRunner.query(
      `ALTER TABLE "jwt_revoked_tokens" ADD COLUMN IF NOT EXISTS "userId" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tableExists = await queryRunner.hasTable('jwt_revoked_tokens');
    if (!tableExists) {
      return;
    }

    await queryRunner.query(
      `ALTER TABLE "jwt_revoked_tokens" DROP COLUMN IF EXISTS "userId"`,
    );
  }
}
