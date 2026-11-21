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
exports.TelegramBotFileGrant = void 0;
const database_types_1 = require("../../database/database-types");
const typeorm_1 = require("typeorm");
/**
 * Telegram Bot 直链授权记录（grant）。
 *
 * 设计要点：
 * - TG 用户 ID 可能超出 32 位整数，统一以字符串（varchar）存储（R5）；
 * - Token 双轨存储：`tokenHash`（SHA-256，校验用，不可逆）+
 *   `tokenCipher`（AES-256-GCM，仅管理员查询时解密回放，可缺失）（C-3/R9）；
 * - `(receiverBotId, telegramUserId, chatId, messageId)` 唯一：同一条消息重投时幂等命中，
 *   不重复扣配额、不重复签发（R7）；
 * - 用户名/显示名为签发时刻快照（TG 用户名可随时修改，R6）；
 * - `accessCount` 仅供统计，任何路径不得据此拦截（D2）。
 */
let TelegramBotFileGrant = class TelegramBotFileGrant {
};
exports.TelegramBotFileGrant = TelegramBotFileGrant;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, comment: 'TG 用户 ID（身份依据）' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "telegramUserId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: 'TG 用户名快照' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "telegramUsername", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 128, nullable: true, comment: 'TG 显示名快照' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "telegramDisplayName", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, comment: '聊天 ID（私聊）' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "chatId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, comment: '消息 ID（幂等锚点）' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "messageId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, nullable: true }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "receiverBotId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 512, comment: 'Telegram file_id' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "telegramFileId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 128, nullable: true, comment: '内容标识 file_unique_id（跨账号稳定，用于把群内认领归因回该 grant）' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "fileUniqueId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '产生 file_id 的 Bot 账号 ID（回退安全锚点）' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "sourceAccountId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 255, nullable: true, comment: '文件名' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "fileName", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 128, nullable: true, comment: 'MIME 类型' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "mimeType", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'bigint', nullable: true, comment: '文件大小（字节）' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "fileSize", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, default: 'telegram', comment: '存储后端：telegram|gdrive' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "storageBackend", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '存储账号 ID（非 TG 后端）' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "storageAccountId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 1024, nullable: true, comment: '对象引用（非 TG 后端）' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "storageObjectRef", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '远端对象删除时间戳' }),
    __metadata("design:type", Date)
], TelegramBotFileGrant.prototype, "storagePurgedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: 'Google 缓存账号 ID' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "gdriveCacheAccountId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 1024, nullable: true, comment: 'Google 缓存对象引用' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "gdriveCacheObjectRef", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, nullable: true, default: 'none', comment: 'Google 缓存状态' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "gdriveCacheStatus", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, comment: 'SHA-256(token)' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "tokenHash", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 1024, nullable: true, comment: 'AES-256-GCM 密文（可回放）' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "tokenCipher", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, comment: 'Token 展示前缀' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "tokenPrefix", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, nullable: true, comment: '密文算法版本' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "cipherVersion", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), comment: '过期时间' }),
    __metadata("design:type", Date)
], TelegramBotFileGrant.prototype, "expiresAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '软撤销时间' }),
    __metadata("design:type", Date)
], TelegramBotFileGrant.prototype, "revokedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '撤销者 ID' }),
    __metadata("design:type", String)
], TelegramBotFileGrant.prototype, "revokedBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0, comment: '访问计数（仅统计）' }),
    __metadata("design:type", Number)
], TelegramBotFileGrant.prototype, "accessCount", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '最近访问时间' }),
    __metadata("design:type", Date)
], TelegramBotFileGrant.prototype, "lastAccessedAt", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ comment: '签发时间' }),
    __metadata("design:type", Date)
], TelegramBotFileGrant.prototype, "createdAt", void 0);
exports.TelegramBotFileGrant = TelegramBotFileGrant = __decorate([
    (0, typeorm_1.Entity)('telegram_bot_file_grants'),
    (0, typeorm_1.Index)('idx_tg_bot_grants_tgUser', ['telegramUserId']),
    (0, typeorm_1.Index)('idx_tg_bot_grants_expiresAt', ['expiresAt']),
    (0, typeorm_1.Index)('uq_tg_bot_grants_tokenHash', ['tokenHash'], { unique: true }),
    (0, typeorm_1.Index)('uq_tg_bot_grants_message', ['receiverBotId', 'telegramUserId', 'chatId', 'messageId'], { unique: true }),
    (0, typeorm_1.Index)('uq_tg_bot_grants_legacy_message', ['telegramUserId', 'chatId', 'messageId'], { unique: true, where: '"receiverBotId" IS NULL' }),
    (0, typeorm_1.Index)('idx_tg_bot_grants_fileUniqueId', ['fileUniqueId']),
    (0, typeorm_1.Index)('idx_tg_bot_grants_purge_sweep', ['storageBackend', 'storagePurgedAt', 'expiresAt']),
    (0, typeorm_1.Index)('idx_tg_bot_grants_gdrive_cache_ref', ['gdriveCacheAccountId', 'gdriveCacheObjectRef'])
], TelegramBotFileGrant);
