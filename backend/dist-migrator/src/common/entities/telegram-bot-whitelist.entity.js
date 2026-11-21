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
exports.TelegramBotWhitelist = void 0;
const typeorm_1 = require("typeorm");
/**
 * Telegram Bot 白名单。
 *
 * - 仅永久加入/移除，无过期语义（D3）；
 * - `enabled=false` 用于撤销（保留审计痕迹）；
 * - `source` 标记来源（env / admin），`createdBy` 记录操作者 TG 用户 ID；
 * - 白名单仅豁免每日配额，不豁免大小/频率/并发/TTL/管理员安全校验。
 */
let TelegramBotWhitelist = class TelegramBotWhitelist {
};
exports.TelegramBotWhitelist = TelegramBotWhitelist;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], TelegramBotWhitelist.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, comment: 'TG 用户 ID' }),
    __metadata("design:type", String)
], TelegramBotWhitelist.prototype, "telegramUserId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'boolean', default: true, comment: '是否启用（false 表示已移除）' }),
    __metadata("design:type", Boolean)
], TelegramBotWhitelist.prototype, "enabled", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, default: 'admin', comment: '来源' }),
    __metadata("design:type", String)
], TelegramBotWhitelist.prototype, "source", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, nullable: true, comment: '操作者 TG 用户 ID' }),
    __metadata("design:type", String)
], TelegramBotWhitelist.prototype, "createdBy", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ comment: '创建时间' }),
    __metadata("design:type", Date)
], TelegramBotWhitelist.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)({ comment: '更新时间' }),
    __metadata("design:type", Date)
], TelegramBotWhitelist.prototype, "updatedAt", void 0);
exports.TelegramBotWhitelist = TelegramBotWhitelist = __decorate([
    (0, typeorm_1.Entity)('telegram_bot_whitelist'),
    (0, typeorm_1.Index)('uq_tg_bot_whitelist_tgUser', ['telegramUserId'], { unique: true })
], TelegramBotWhitelist);
