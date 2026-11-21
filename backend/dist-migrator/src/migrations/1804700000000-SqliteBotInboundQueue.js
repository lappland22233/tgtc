"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteBotInboundQueue1804700000000 = void 0;
const bot_inbound_queue_schema_1 = require("./bot-inbound-queue-schema");
class SqliteBotInboundQueue1804700000000 {
    async up(runner) {
        if (runner.dataSource.options.type !== 'better-sqlite3')
            return;
        await (0, bot_inbound_queue_schema_1.createBotInboundQueue)(runner, true);
        // SQLite TEXT affinity already stores full administrator UUIDs in revokedBy.
    }
    async down() {
        // Preserve the exact task and ban state on migration replay.
    }
}
exports.SqliteBotInboundQueue1804700000000 = SqliteBotInboundQueue1804700000000;
