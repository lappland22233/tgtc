"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteRevokePrivateLegacyShares1802000000000 = void 0;
/**
 * v1.2.6 安全回填（SQLite 方言）：撤销「文件已转私有但 legacy 公开直链仍存活」的分享。
 * 与 1802000000000-RevokePrivateLegacyShares.ts（PostgreSQL）语义一致，幂等。
 */
class SqliteRevokePrivateLegacyShares1802000000000 {
    constructor() {
        this.name = 'SqliteRevokePrivateLegacyShares1802000000000';
    }
    async up(queryRunner) {
        if (queryRunner.dataSource.options.type !== 'better-sqlite3')
            return;
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
    async down() {
        // 安全状态收紧，不可逆：撤销的 legacy 直链不恢复。
    }
}
exports.SqliteRevokePrivateLegacyShares1802000000000 = SqliteRevokePrivateLegacyShares1802000000000;
