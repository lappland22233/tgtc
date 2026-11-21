"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteAddGDriveCacheColumns1804300000000 = void 0;
/**
 * `files` 与 `telegram_bot_file_grants` 表新增 Google 缓存三列（SQLite 方言）。
 *
 * 字段说明：
 * - `gdriveCacheAccountId`: Google 缓存所在的 GDrive 账号 ID；
 * - `gdriveCacheObjectRef`: Google 缓存远端对象引用（Google Drive fileId）；
 * - `gdriveCacheStatus`: 缓存状态（'none' | 'pending' | 'ready' | 'failed'），默认 'none'。
 */
class SqliteAddGDriveCacheColumns1804300000000 {
    constructor() {
        this.name = 'SqliteAddGDriveCacheColumns1804300000000';
    }
    async up(queryRunner) {
        if (queryRunner.dataSource.options.type !== 'better-sqlite3')
            return;
        const filesTable = await queryRunner.getTable('files');
        if (filesTable) {
            if (!filesTable.columns.some((c) => c.name === 'gdriveCacheAccountId')) {
                await queryRunner.query(`ALTER TABLE "files" ADD COLUMN "gdriveCacheAccountId" varchar(64)`);
            }
            if (!filesTable.columns.some((c) => c.name === 'gdriveCacheObjectRef')) {
                await queryRunner.query(`ALTER TABLE "files" ADD COLUMN "gdriveCacheObjectRef" varchar(1024)`);
            }
            if (!filesTable.columns.some((c) => c.name === 'gdriveCacheStatus')) {
                await queryRunner.query(`ALTER TABLE "files" ADD COLUMN "gdriveCacheStatus" varchar(16) DEFAULT 'none'`);
            }
            await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_files_gdrive_cache_ref"`
                + ` ON "files" ("gdriveCacheAccountId", "gdriveCacheObjectRef")`);
        }
        const grantsTable = await queryRunner.getTable('telegram_bot_file_grants');
        if (grantsTable) {
            if (!grantsTable.columns.some((c) => c.name === 'gdriveCacheAccountId')) {
                await queryRunner.query(`ALTER TABLE "telegram_bot_file_grants" ADD COLUMN "gdriveCacheAccountId" varchar(64)`);
            }
            if (!grantsTable.columns.some((c) => c.name === 'gdriveCacheObjectRef')) {
                await queryRunner.query(`ALTER TABLE "telegram_bot_file_grants" ADD COLUMN "gdriveCacheObjectRef" varchar(1024)`);
            }
            if (!grantsTable.columns.some((c) => c.name === 'gdriveCacheStatus')) {
                await queryRunner.query(`ALTER TABLE "telegram_bot_file_grants" ADD COLUMN "gdriveCacheStatus" varchar(16) DEFAULT 'none'`);
            }
            await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_tg_bot_grants_gdrive_cache_ref"`
                + ` ON "telegram_bot_file_grants" ("gdriveCacheAccountId", "gdriveCacheObjectRef")`);
        }
    }
    async down(queryRunner) {
        if (queryRunner.dataSource.options.type !== 'better-sqlite3')
            return;
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_bot_grants_gdrive_cache_ref"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_gdrive_cache_ref"`);
    }
}
exports.SqliteAddGDriveCacheColumns1804300000000 = SqliteAddGDriveCacheColumns1804300000000;
