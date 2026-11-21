"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramBotInboundTask = void 0;
const typeorm_1 = require("typeorm");
const database_types_1 = require("../../database/database-types");
const timestamp = (0, database_types_1.databaseColumnType)('timestamptz');
let TelegramBotInboundTask = class TelegramBotInboundTask {
};
exports.TelegramBotInboundTask = TelegramBotInboundTask;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)({ type: 'integer' }),
    __metadata("design:type", Number)
], TelegramBotInboundTask.prototype, "sequence", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 36 }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32 }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "receiverBotId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "sourceAccountId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32 }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "telegramUserId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "telegramUsername", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 128, nullable: true }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "telegramDisplayName", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32 }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "chatId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32 }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "messageId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 512 }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "telegramFileId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 128, nullable: true }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "fileUniqueId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 255, nullable: true }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "fileName", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 128, nullable: true }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "mimeType", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'bigint', nullable: true, transformer: {
            to: (value) => value,
            from: (value) => value === null ? null : String(value),
        } }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "fileSize", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16 }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', nullable: true }),
    __metadata("design:type", Number)
], TelegramBotInboundTask.prototype, "waitingMsgId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, nullable: true }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "noticeStatus", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', nullable: true }),
    __metadata("design:type", Number)
], TelegramBotInboundTask.prototype, "noticePosition", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: timestamp, nullable: true }),
    __metadata("design:type", Date)
], TelegramBotInboundTask.prototype, "nextNoticeAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: timestamp, nullable: true }),
    __metadata("design:type", Date)
], TelegramBotInboundTask.prototype, "noticeLeaseUntil", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: timestamp, nullable: true }),
    __metadata("design:type", Date)
], TelegramBotInboundTask.prototype, "availableAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: timestamp, nullable: true }),
    __metadata("design:type", Date)
], TelegramBotInboundTask.prototype, "botCooldownUntil", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 255, nullable: true }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "failureReason", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 10 }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "usageDate", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'boolean' }),
    __metadata("design:type", Boolean)
], TelegramBotInboundTask.prototype, "quotaConsumed", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int' }),
    __metadata("design:type", Number)
], TelegramBotInboundTask.prototype, "quotaUsed", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 36, nullable: true }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "leaseToken", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: timestamp, nullable: true }),
    __metadata("design:type", Date)
], TelegramBotInboundTask.prototype, "leaseExpiresAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 36, nullable: true }),
    __metadata("design:type", String)
], TelegramBotInboundTask.prototype, "grantId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: timestamp }),
    __metadata("design:type", Date)
], TelegramBotInboundTask.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: timestamp }),
    __metadata("design:type", Date)
], TelegramBotInboundTask.prototype, "updatedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: timestamp, nullable: true }),
    __metadata("design:type", Date)
], TelegramBotInboundTask.prototype, "startedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: timestamp, nullable: true }),
    __metadata("design:type", Date)
], TelegramBotInboundTask.prototype, "finishedAt", void 0);
exports.TelegramBotInboundTask = TelegramBotInboundTask = __decorate([
    (0, typeorm_1.Entity)('telegram_bot_inbound_tasks'),
    (0, typeorm_1.Index)('uq_bot_inbound_id', ['id'], { unique: true }),
    (0, typeorm_1.Index)('uq_bot_inbound_message', ['receiverBotId', 'telegramUserId', 'chatId', 'messageId'], { unique: true }),
    (0, typeorm_1.Index)('uq_bot_inbound_running', ['receiverBotId'], { unique: true, where: '"leaseToken" IS NOT NULL' }),
    (0, typeorm_1.Index)('idx_bot_inbound_fifo', ['receiverBotId', 'status', 'sequence']),
    (0, typeorm_1.Index)('idx_bot_inbound_cooldown', ['receiverBotId', 'botCooldownUntil'], { where: '"botCooldownUntil" IS NOT NULL' }),
    (0, typeorm_1.Index)('idx_bot_inbound_notice_lease', ['receiverBotId', 'noticeLeaseUntil'], { where: '"noticeLeaseUntil" IS NOT NULL' }),
    (0, typeorm_1.Index)('idx_bot_inbound_terminal_notice', ['receiverBotId', 'sequence'], {
        where: `"status" IN ('completed','failed','cancelled') AND ("noticeStatus" IS NULL OR "noticeStatus" <> "status")`,
    }),
    (0, typeorm_1.Index)('idx_bot_inbound_user', ['telegramUserId', 'sequence'])
], TelegramBotInboundTask);
