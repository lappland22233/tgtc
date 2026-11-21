"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteGDriveOAuthFlows1804500000000 = void 0;
class SqliteGDriveOAuthFlows1804500000000 {
    async up(queryRunner) {
        if (queryRunner.dataSource.options.type !== 'better-sqlite3')
            return;
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "gdrive_oauth_flows" (
      "stateHash" varchar(64) PRIMARY KEY NOT NULL,
      "bindingHash" varchar(64) NOT NULL,
      "expiresAt" bigint NOT NULL
    )`);
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_gdrive_oauth_flows_expires" ON "gdrive_oauth_flows" ("expiresAt")');
    }
    async down(queryRunner) {
        if (queryRunner.dataSource.options.type !== 'better-sqlite3')
            return;
        await queryRunner.query('DROP TABLE IF EXISTS "gdrive_oauth_flows"');
    }
}
exports.SqliteGDriveOAuthFlows1804500000000 = SqliteGDriveOAuthFlows1804500000000;
