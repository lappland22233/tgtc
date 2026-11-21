"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteAddFileTelegramSourceFields1803200000000 = void 0;
/**
 * `files` 表补齐主副本远端定位字段（SQLite 方言）。
 *
 * 全新库由 SQLite 基线按实体元数据建表；存量库基线已执行不会重跑，故此处用
 * `getTable` 判定后逐列补齐（SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，
 * 与 180230/180260 一致）。
 *
 * 注意：本文件必须带 `-Sqlite` 后缀，否则不会被正式 SQLite 迁移 glob 加载。
 */
class SqliteAddFileTelegramSourceFields1803200000000 {
    constructor() {
        this.name = 'SqliteAddFileTelegramSourceFields1803200000000';
    }
    async up(queryRunner) {
        if (queryRunner.connection.options.type !== 'sqlite')
            return;
        const table = await queryRunner.getTable('files');
        if (!table)
            return;
        const additions = [
            { name: 'telegramChatId', definition: 'varchar(32)' },
            { name: 'telegramMessageId', definition: 'varchar(32)' },
            { name: 'telegramFileUniqueId', definition: 'varchar(256)' },
            { name: 'telegramSourceAccountId', definition: 'varchar(64)' },
        ];
        for (const column of additions) {
            if (table.columns.some((existing) => existing.name === column.name))
                continue;
            await queryRunner.query(`ALTER TABLE "files" ADD COLUMN "${column.name}" ${column.definition}`);
        }
    }
    async down(queryRunner) {
        if (queryRunner.connection.options.type !== 'sqlite')
            return;
        // SQLite 旧版本不支持 DROP COLUMN；保留可空列无数据风险，与既有迁移保持一致。
    }
}
exports.SqliteAddFileTelegramSourceFields1803200000000 = SqliteAddFileTelegramSourceFields1803200000000;
