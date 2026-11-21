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
exports.TelegramBotDailyUsage = void 0;
const typeorm_1 = require("typeorm");
/**
 * Telegram Bot 每日配额用量。
 *
 * - `usageDate` 为按配置时区（默认 Asia/Shanghai）计算的业务日期（YYYY-MM-DD）；
 * - `(telegramUserId, usageDate)` 唯一；配额扣减必须使用原子 UPDATE
 *   （`SET issuedCount = issuedCount + 1 WHERE issuedCount < limit`），禁止先查后写（R3）。
 */
let TelegramBotDailyUsage = class TelegramBotDailyUsage {
};
exports.TelegramBotDailyUsage = TelegramBotDailyUsage;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], TelegramBotDailyUsage.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, comment: 'TG 用户 ID' }),
    __metadata("design:type", String)
], TelegramBotDailyUsage.prototype, "telegramUserId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 10, comment: '业务日期（切日时区）' }),
    __metadata("design:type", String)
], TelegramBotDailyUsage.prototype, "usageDate", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0, comment: '当日已签发直链数' }),
    __metadata("design:type", Number)
], TelegramBotDailyUsage.prototype, "issuedCount", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ comment: '创建时间' }),
    __metadata("design:type", Date)
], TelegramBotDailyUsage.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)({ comment: '更新时间' }),
    __metadata("design:type", Date)
], TelegramBotDailyUsage.prototype, "updatedAt", void 0);
exports.TelegramBotDailyUsage = TelegramBotDailyUsage = __decorate([
    (0, typeorm_1.Entity)('telegram_bot_daily_usage'),
    (0, typeorm_1.Index)('uq_tg_bot_daily_usage_user_date', ['telegramUserId', 'usageDate'], { unique: true })
], TelegramBotDailyUsage);
