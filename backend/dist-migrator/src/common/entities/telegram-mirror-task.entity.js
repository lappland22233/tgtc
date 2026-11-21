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
exports.TelegramMirrorTask = void 0;
const database_types_1 = require("../../database/database-types");
const typeorm_1 = require("typeorm");
/**
 * Telegram 文件镜像任务（持久化，取代进程内 Map）。
 *
 * 为什么必须持久化：镜像要能重试、能在重启后恢复、能在失败时被管理员看见并重试；
 * 进程内 Map 一旦重启即丢失，会出现「主文件成功但备份永远缺失且无人知晓」。
 *
 * 幂等键 = `(ruleId, ownerType, ownerId, sourceVersion)`：
 * - **每条启用规则一行任务**（一个镜像群一行），各自独立重试与计数；
 * - 重复事件、Bull 重试、进程重启都收敛到同一条任务记录；
 * - Bull 侧使用同一字符串生成确定性 jobId 做入队去重。
 *
 * 执行链路（唯一）：持有源消息的 Bot 先把消息转发进**主群**
 * （落点持久化在 `telegram_main_chat_anchors`，按 `(ownerType, ownerId)` 共享），
 * 用户账号再从主群服务端转发到 `targetChatId`。
 * 因此本表行的 `sourceChatId/sourceMessageId` 是**源事实**（用于搬运），
 * 真正的中继源锚点由主群锚点表提供。
 *
 * 覆盖上传：`sourceVersion` 绑定 `File.uploadVersion`，旧任务检测到版本变化后
 * 终止或标记过期，绝不把旧内容写进镜像群。
 */
let TelegramMirrorTask = class TelegramMirrorTask {
};
exports.TelegramMirrorTask = TelegramMirrorTask;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], TelegramMirrorTask.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('uuid'), comment: '所属镜像规则' }),
    __metadata("design:type", String)
], TelegramMirrorTask.prototype, "ruleId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, comment: '归属对象类型：file|grant|fileUnique' }),
    __metadata("design:type", String)
], TelegramMirrorTask.prototype, "ownerType", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, comment: '归属对象 ID' }),
    __metadata("design:type", String)
], TelegramMirrorTask.prototype, "ownerId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 1, comment: '源内容版本（覆盖上传递增）' }),
    __metadata("design:type", Number)
], TelegramMirrorTask.prototype, "sourceVersion", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '源副本账号 ID' }),
    __metadata("design:type", String)
], TelegramMirrorTask.prototype, "sourceAccountId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, nullable: true, comment: '源 Chat（搬运到主群前的原始位置）' }),
    __metadata("design:type", String)
], TelegramMirrorTask.prototype, "sourceChatId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, nullable: true, comment: '源消息 ID（搬运到主群前的原始位置）' }),
    __metadata("design:type", String)
], TelegramMirrorTask.prototype, "sourceMessageId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '实际执行账号 ID（用户账号）' }),
    __metadata("design:type", String)
], TelegramMirrorTask.prototype, "targetAccountId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, comment: '[废弃] 历史执行模式列' }),
    __metadata("design:type", String)
], TelegramMirrorTask.prototype, "mode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, default: 'queued', comment: '任务状态' }),
    __metadata("design:type", String)
], TelegramMirrorTask.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0, comment: '已尝试次数' }),
    __metadata("design:type", Number)
], TelegramMirrorTask.prototype, "attempts", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, nullable: true, comment: '备份群消息 ID' }),
    __metadata("design:type", String)
], TelegramMirrorTask.prototype, "targetMessageId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 512, nullable: true, comment: '目标账号自己的 file_id（仅该账号可用）' }),
    __metadata("design:type", String)
], TelegramMirrorTask.prototype, "targetTelegramFileId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, nullable: true, comment: '目标 Chat' }),
    __metadata("design:type", String)
], TelegramMirrorTask.prototype, "targetChatId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'boolean', default: false, comment: '存在待落库的目标侧回执' }),
    __metadata("design:type", Boolean)
], TelegramMirrorTask.prototype, "receiptPending", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '最近错误分类（脱敏）' }),
    __metadata("design:type", String)
], TelegramMirrorTask.prototype, "lastErrorCode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 500, nullable: true, comment: '最近错误摘要（脱敏）' }),
    __metadata("design:type", String)
], TelegramMirrorTask.prototype, "lastErrorSummary", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '下次重试时间' }),
    __metadata("design:type", Date)
], TelegramMirrorTask.prototype, "nextRetryAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '开始执行时间' }),
    __metadata("design:type", Date)
], TelegramMirrorTask.prototype, "startedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '完成时间' }),
    __metadata("design:type", Date)
], TelegramMirrorTask.prototype, "completedAt", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ comment: '创建时间' }),
    __metadata("design:type", Date)
], TelegramMirrorTask.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)({ comment: '更新时间' }),
    __metadata("design:type", Date)
], TelegramMirrorTask.prototype, "updatedAt", void 0);
exports.TelegramMirrorTask = TelegramMirrorTask = __decorate([
    (0, typeorm_1.Entity)('telegram_mirror_tasks'),
    (0, typeorm_1.Index)('uq_tg_mirror_tasks_idempotency', ['ruleId', 'ownerType', 'ownerId', 'sourceVersion'], { unique: true }),
    (0, typeorm_1.Index)('idx_tg_mirror_tasks_status', ['status']),
    (0, typeorm_1.Index)('idx_tg_mirror_tasks_rule_status', ['ruleId', 'status']),
    (0, typeorm_1.Index)('idx_tg_mirror_tasks_next_retry', ['nextRetryAt'])
], TelegramMirrorTask);
