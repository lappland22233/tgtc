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
exports.TelegramMainChatAnchor = void 0;
const database_types_1 = require("../../database/database-types");
const typeorm_1 = require("typeorm");
/**
 * 主群锚点表（副本扩散的唯一中转落点）。
 *
 * ## 为什么必须有这张表
 *
 * 副本扩散链路是「持有源消息的 Bot 先把消息转发进**主群**，再由用户账号(userbot)从主群
 * 服务端转发到各镜像群」。用户账号读不到「Bot 与用户的私聊」，也未必是各账号存储 Chat 的
 * 成员，因此源锚点必须先落到主群才能被中继。
 *
 * Bot API 的 `forwardMessage` **没有幂等键**：重试会再搬一次并在主群留下重复消息。
 * 因此搬运必须**先落库（预留 `pending`）再执行**，且落点必须是**所有镜像规则共享**的一行——
 * 若把锚点写在各条任务行上（每条规则一行），同一文件会被搬运 N 次。
 *
 * ## 约束
 *
 * - `(ownerType, ownerId)` 唯一：同一个逻辑归属对象在主群只有一个落点；
 * - `anchorChatId + anchorMessageId` 是 MTProto 中继的源锚点（消息 ID 与 Bot API 同源）；
 * - 主群变更（管理员改规则的 `sourceChatId`）时，锚点行会被**重写**为新主群
 *   （接管路径统一走「删旧行 + 重新插入」的唯一键 CAS，行 id 会变），
 *   旧主群里的历史消息保留为孤儿（不删除、无法自动清理，需人工处理）；
 * - 不建外键：与站内文件/授权体系解耦，便于按归属对象独立清理。
 */
let TelegramMainChatAnchor = class TelegramMainChatAnchor {
};
exports.TelegramMainChatAnchor = TelegramMainChatAnchor;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], TelegramMainChatAnchor.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, comment: '归属对象类型：file|grant|fileUnique' }),
    __metadata("design:type", String)
], TelegramMainChatAnchor.prototype, "ownerType", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, comment: '归属对象 ID（files.id / grant.id / file_unique_id）' }),
    __metadata("design:type", String)
], TelegramMainChatAnchor.prototype, "ownerId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, comment: '主群 chat id（中转落点，硬约束：必须为群/频道）' }),
    __metadata("design:type", String)
], TelegramMainChatAnchor.prototype, "anchorChatId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, nullable: true, comment: '主群消息 ID（中继源锚点）' }),
    __metadata("design:type", String)
], TelegramMainChatAnchor.prototype, "anchorMessageId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '执行搬运的 Bot 账号 ID' }),
    __metadata("design:type", String)
], TelegramMainChatAnchor.prototype, "plantedByAccountId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, nullable: true, comment: '原锚点 chat id（审计）' }),
    __metadata("design:type", String)
], TelegramMainChatAnchor.prototype, "sourceChatId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, nullable: true, comment: '原锚点消息 ID（审计）' }),
    __metadata("design:type", String)
], TelegramMainChatAnchor.prototype, "sourceMessageId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, default: 'ready', comment: '状态：pending|ready|failed' }),
    __metadata("design:type", String)
], TelegramMainChatAnchor.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 500, nullable: true, comment: '最近失败原因（脱敏）' }),
    __metadata("design:type", String)
], TelegramMainChatAnchor.prototype, "lastError", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: 'pending=预留时间（租约）；ready=搬运完成时间' }),
    __metadata("design:type", Date)
], TelegramMainChatAnchor.prototype, "plantedAt", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ comment: '创建时间' }),
    __metadata("design:type", Date)
], TelegramMainChatAnchor.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)({ comment: '更新时间' }),
    __metadata("design:type", Date)
], TelegramMainChatAnchor.prototype, "updatedAt", void 0);
exports.TelegramMainChatAnchor = TelegramMainChatAnchor = __decorate([
    (0, typeorm_1.Entity)('telegram_main_chat_anchors'),
    (0, typeorm_1.Index)('uq_tg_main_chat_anchors_owner', ['ownerType', 'ownerId'], { unique: true }),
    (0, typeorm_1.Index)('idx_tg_main_chat_anchors_anchor', ['anchorChatId', 'anchorMessageId'])
], TelegramMainChatAnchor);
