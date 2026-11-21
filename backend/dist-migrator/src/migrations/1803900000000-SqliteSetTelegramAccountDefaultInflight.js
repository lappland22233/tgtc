"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteSetTelegramAccountDefaultInflight1803900000000 = void 0;
/**
 * SQLite 无法直接修改既有列默认值；应用层会为新建账号提供 maxInflight=16。
 * 存量值无法区分旧默认与管理员显式设置，因此此迁移不回填、不改写任何账号行。
 */
class SqliteSetTelegramAccountDefaultInflight1803900000000 {
    constructor() {
        this.name = 'SqliteSetTelegramAccountDefaultInflight1803900000000';
    }
    async up(queryRunner) {
        if (queryRunner.dataSource.options.type !== 'better-sqlite3')
            return;
        await queryRunner.query('PRAGMA table_info("telegram_accounts")');
    }
    async down(queryRunner) {
        if (queryRunner.dataSource.options.type !== 'better-sqlite3')
            return;
        // 应用层默认值及账号数据不由此迁移管理；无可安全逆转的 schema 变更。
    }
}
exports.SqliteSetTelegramAccountDefaultInflight1803900000000 = SqliteSetTelegramAccountDefaultInflight1803900000000;
