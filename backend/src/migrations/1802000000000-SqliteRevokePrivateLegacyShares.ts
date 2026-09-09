import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * v1.2.6 安全回填（SQLite 方言）：撤销「文件已转私有但 legacy 公开直链仍存活」的分享。
 * 与 1802000000000-RevokePrivateLegacyShares.ts（PostgreSQL）语义一致，幂等。
 */
export class SqliteRevokePrivateLegacyShares1802000000000 implements MigrationInterface {
  name = 'SqliteRevokePrivateLegacyShares1802000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    await queryRunner.query(`
      UPDATE "share_links"
      SET "isDeleted" = 1, "updatedAt" = datetime('now')
      WHERE "isDeleted" = 0
        AND "targetType" = 'file'
        AND "token" = "targetId"
        AND EXISTS (
          SELECT 1 FROM "files" f
          WHERE f."id" = "share_links"."targetId"
            AND f."accessType" = 'private'
        )
    `);
  }

  public async down(): Promise<void> {
    // 安全状态收紧，不可逆：撤销的 legacy 直链不恢复。
  }
}
