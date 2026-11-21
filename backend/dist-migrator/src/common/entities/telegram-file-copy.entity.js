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
exports.TelegramFileCopy = void 0;
const database_types_1 = require("../../database/database-types");
const typeorm_1 = require("typeorm");
/**
 * Telegram 文件副本表（多账号回源的核心）。
 *
 * 为什么必须有这张表：**`file_id` 是账号隔离的**，同一个文件在不同 Bot 账号下
 * 是不同的 `file_id`；因此「按负载挑一个账号回源」的前提是**该账号持有自己的副本
 * 记录**。本表即「逻辑文件 → 各账号的 file_id 映射」。
 *
 * 关键约束：
 * - `(ownerType, ownerId, accountId)` 唯一：同账号同文件只允许一条，重投幂等；
 * - `telegramFileId` 与产生它的账号绑定，**禁止跨账号复用**（跨实例复用会得到
 *   上游 `Exact file size is unavailable from Telegram`）；
 * - 不建外键：与站内用户体系、Bot 授权体系解耦，便于独立清理。
 */
let TelegramFileCopy = class TelegramFileCopy {
};
exports.TelegramFileCopy = TelegramFileCopy;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], TelegramFileCopy.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, comment: '归属对象类型：fileUnique|file|grant' }),
    __metadata("design:type", String)
], TelegramFileCopy.prototype, "ownerType", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, comment: '归属对象 ID（files.id 或 grant.id）' }),
    __metadata("design:type", String)
], TelegramFileCopy.prototype, "ownerId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, comment: 'Bot 账号标识（botId）' }),
    __metadata("design:type", String)
], TelegramFileCopy.prototype, "accountId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 512, comment: '该账号的 Telegram file_id' }),
    __metadata("design:type", String)
], TelegramFileCopy.prototype, "telegramFileId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, nullable: true, comment: '产生 file_id 的 chat id' }),
    __metadata("design:type", String)
], TelegramFileCopy.prototype, "chatId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, nullable: true, comment: '消息 ID（转发锚点）' }),
    __metadata("design:type", String)
], TelegramFileCopy.prototype, "messageId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'bigint', nullable: true, comment: '文件大小（字节）' }),
    __metadata("design:type", String)
], TelegramFileCopy.prototype, "fileSize", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, default: 'inbound', comment: '副本来源：inbound|replicated|relayed' }),
    __metadata("design:type", String)
], TelegramFileCopy.prototype, "source", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, default: 'ready', comment: '状态：ready|pending|failed' }),
    __metadata("design:type", String)
], TelegramFileCopy.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 500, nullable: true, comment: '最近失败原因（脱敏）' }),
    __metadata("design:type", String)
], TelegramFileCopy.prototype, "lastError", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '最近一次用于取流的时间' }),
    __metadata("design:type", Date)
], TelegramFileCopy.prototype, "lastUsedAt", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ comment: '创建时间' }),
    __metadata("design:type", Date)
], TelegramFileCopy.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)({ comment: '更新时间' }),
    __metadata("design:type", Date)
], TelegramFileCopy.prototype, "updatedAt", void 0);
exports.TelegramFileCopy = TelegramFileCopy = __decorate([
    (0, typeorm_1.Entity)('telegram_file_copies'),
    (0, typeorm_1.Index)('uq_tg_file_copies_owner_account', ['ownerType', 'ownerId', 'accountId'], { unique: true }),
    (0, typeorm_1.Index)('idx_tg_file_copies_owner', ['ownerType', 'ownerId']),
    (0, typeorm_1.Index)('idx_tg_file_copies_status', ['status']),
    (0, typeorm_1.Index)('idx_tg_file_copies_anchor', ['chatId', 'messageId']),
    (0, typeorm_1.Index)('idx_tg_file_copies_anchor_owner', ['chatId', 'messageId', 'ownerType', 'ownerId'])
    /**
     * 锚点一致性（**只约束 `fileUnique` 命名空间，且按账号维度**）。
     *
     * 语义：**同一个账号**在同一条消息上只能登记一个逻辑主键。
     *
     * 为什么不是「(chatId, messageId) 唯一」：那会直接打断两处**合法**场景——
     * 1. 同一备份群里多个 Bot 都会收到**同一条消息**，各自以自己的 `accountId` 登记
     *    自己的 `file_id`（同一 `file_unique_id`、不同账号）；若锚点唯一，第二个 Bot
     *    将永远登记失败（副本分布就再也扩不出去）；
     * 2. 桥接双写：`bridgeInboundCopyToLogicalFile` 会把同一锚点额外写到 `file`
     *    命名空间（`file_unique_id` 可能命中多条站内文件），同一锚点对应多个 `ownerId`
     *    是设计内行为。
     *
     * 因此唯一键取 `(chatId, messageId, ownerType, ownerId, accountId)` 之外的
     * **最小可靠约束**：`(chatId, messageId, accountId) where ownerType='fileUnique'`。
     * 它挡住的是真正的脏数据来源——同一账号在同一条消息上登记互相矛盾的逻辑主键
     * （重复登记 / 锚点串号），而这类脏数据正是「回源候选集合在命名空间之间漂移、
     * 同一个文件看起来总压在同一账号」的成因。
     *
     * 跨账号的分歧（两个账号对同一消息给出不同 `file_unique_id`）无法用单索引表达，
     * 由 `FileCopyService.findByAnchor` 的确定性收敛 + `anchorConflicts` 计数暴露给审计。
     */
    ,
    (0, typeorm_1.Index)('uq_tg_file_copies_anchor_account', ['chatId', 'messageId', 'accountId'], {
        unique: true,
        where: `"ownerType" = 'fileUnique' AND "chatId" IS NOT NULL AND "messageId" IS NOT NULL`,
    })
], TelegramFileCopy);
