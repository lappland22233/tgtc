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
exports.TelegramMirrorRule = void 0;
const database_types_1 = require("../../database/database-types");
const typeorm_1 = require("typeorm");
/**
 * 镜像规则（**多规则**：每条启用规则对应一个镜像群）。
 *
 * 字段语义（改造后）：
 * - `sourceChatId` = **主群**：副本扩散唯一的中转落点，所有启用规则必须一致
 *   （持有源消息的 Bot 先转发到主群，用户账号再从主群中继到各自镜像群）；
 * - `targetChatId` = **镜像群**（备份群）：该规则的扩散目标；
 * - `mode` / `fallbackMode` 为历史遗留列，见上方 `@deprecated`。
 *
 * 强校验（服务端权威）：
 * - `sourceChatId !== targetChatId`（中转落点与备份必须分离）；
 * - 镜像群不得等于任一 Bot 账号的主存储 Chat（避免账号/消息归属混淆）；
 * - 启用前必须完成主群/镜像群权限测试（`lastTestStatus='ok'`），
 *   且主群与其它启用规则一致。
 *
 * 环境变量不参与规则定义，全部走本表 + 后台热更新并写审计。
 */
let TelegramMirrorRule = class TelegramMirrorRule {
};
exports.TelegramMirrorRule = TelegramMirrorRule;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], TelegramMirrorRule.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'boolean', default: false, comment: '是否启用（多规则：每条启用规则一个镜像群）' }),
    __metadata("design:type", Boolean)
], TelegramMirrorRule.prototype, "enabled", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, comment: '规则名称' }),
    __metadata("design:type", String)
], TelegramMirrorRule.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, comment: '主群 Chat（源群 / 主存储群：副本扩散唯一中转落点）' }),
    __metadata("design:type", String)
], TelegramMirrorRule.prototype, "sourceChatId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, comment: '镜像群 Chat（备份群）' }),
    __metadata("design:type", String)
], TelegramMirrorRule.prototype, "targetChatId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, default: 'bot_upload', comment: '[废弃] 历史镜像模式列' }),
    __metadata("design:type", String)
], TelegramMirrorRule.prototype, "mode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '优先账号 ID（可空）' }),
    __metadata("design:type", String)
], TelegramMirrorRule.prototype, "preferredAccountId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, default: 'disabled', comment: '[废弃] 历史降级策略列' }),
    __metadata("design:type", String)
], TelegramMirrorRule.prototype, "fallbackMode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'boolean', default: true, comment: '是否镜像普通 Web 新上传' }),
    __metadata("design:type", Boolean)
], TelegramMirrorRule.prototype, "includeWebUploads", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'boolean', default: true, comment: '是否镜像 Bot 私聊入站文件' }),
    __metadata("design:type", Boolean)
], TelegramMirrorRule.prototype, "includeBotInboundFiles", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '最近一次权限测试时间' }),
    __metadata("design:type", Date)
], TelegramMirrorRule.prototype, "lastTestedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, default: 'untested', comment: '最近一次权限测试结论' }),
    __metadata("design:type", String)
], TelegramMirrorRule.prototype, "lastTestStatus", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 500, nullable: true, comment: '最近一次权限测试摘要（脱敏）' }),
    __metadata("design:type", String)
], TelegramMirrorRule.prototype, "lastTestSummary", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '创建人（管理员用户 ID）' }),
    __metadata("design:type", String)
], TelegramMirrorRule.prototype, "createdBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '最近修改人（管理员用户 ID）' }),
    __metadata("design:type", String)
], TelegramMirrorRule.prototype, "updatedBy", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ comment: '创建时间' }),
    __metadata("design:type", Date)
], TelegramMirrorRule.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)({ comment: '更新时间' }),
    __metadata("design:type", Date)
], TelegramMirrorRule.prototype, "updatedAt", void 0);
exports.TelegramMirrorRule = TelegramMirrorRule = __decorate([
    (0, typeorm_1.Entity)('telegram_mirror_rules'),
    (0, typeorm_1.Index)('idx_tg_mirror_rules_enabled', ['enabled'])
], TelegramMirrorRule);
