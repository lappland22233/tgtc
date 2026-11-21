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
exports.TelegramReplicationAttempt = void 0;
const database_types_1 = require("../../database/database-types");
const typeorm_1 = require("typeorm");
/**
 * 副本扩散轮次（用户账号服务端中继 + Bot 入站认领）。
 *
 * 定位（改造后）：**认领观测层**，不再是执行入口。执行由镜像任务队列负责
 * （`telegram_mirror_tasks`，每条启用规则一个镜像群），任务中继成功后开立
 * `waiting_claims` 轮次，认领由入站链路回写、窗口到期由生命週期清扫结算。
 *
 * 设计要点：
 * - **每逻辑文件 × 每镜像群每轮一行**（`targetChatId` 参与轮次归属：多镜像群各自独立
 *   退避与计数，A 群的轮次不得被 B 群复用或结算），生命周期时间戳可重建时间线
 *   （startedAt → relayCompletedAt → claimDeadlineAt → completedAt）；同一 owner + 目标群
 *   在合并窗口内的重复阻塞/失败轮次**更新既有行**并累加 `retryCount`，控制行数增长；
 * - **不设 `bytesTransferred` 列**：策略 B 不发生文件字节二次传输，
 *   展示恒为 0 即可，留一列反而会诱导误读为「有字节流动」；
 * - `targetChatId` 内部存储、出参脱敏；`relayAccountId` / `relayMessageId` 仅存内部引用，
 *   不含任何凭据；
 * - 不建外键：与账号体系解耦，便于按保留窗口独立清理。
 */
let TelegramReplicationAttempt = class TelegramReplicationAttempt {
};
exports.TelegramReplicationAttempt = TelegramReplicationAttempt;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], TelegramReplicationAttempt.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, comment: '归属对象类型：file|fileUnique|grant' }),
    __metadata("design:type", String)
], TelegramReplicationAttempt.prototype, "ownerType", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, comment: '归属对象 ID（files.id / file_unique_id / grant.id）' }),
    __metadata("design:type", String)
], TelegramReplicationAttempt.prototype, "ownerId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '源副本账号 ID（仅内部 ID）' }),
    __metadata("design:type", String)
], TelegramReplicationAttempt.prototype, "sourceAccountId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, nullable: true, comment: '副本可见群（内部存储，出参脱敏）' }),
    __metadata("design:type", String)
], TelegramReplicationAttempt.prototype, "targetChatId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 160, nullable: true, comment: '幂等键（重试不变）' }),
    __metadata("design:type", String)
], TelegramReplicationAttempt.prototype, "idempotencyKey", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0, comment: '期望副本数（effectiveTarget）' }),
    __metadata("design:type", Number)
], TelegramReplicationAttempt.prototype, "desiredCount", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0, comment: '本轮开始前已持有的 ready 副本数' }),
    __metadata("design:type", Number)
], TelegramReplicationAttempt.prototype, "baselineReadyCount", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: (0, database_types_1.databaseColumnType)('jsonb'),
        nullable: true,
        comment: '已认领账号 ID 列表（不含凭据）',
    }),
    __metadata("design:type", Array)
], TelegramReplicationAttempt.prototype, "claimedAccountIds", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0, comment: '结束时仍缺的副本数' }),
    __metadata("design:type", Number)
], TelegramReplicationAttempt.prototype, "missingCount", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 24, default: 'planned', comment: '轮次状态' }),
    __metadata("design:type", String)
], TelegramReplicationAttempt.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, nullable: true, comment: '标准化失败原因（脱敏）' }),
    __metadata("design:type", String)
], TelegramReplicationAttempt.prototype, "failureReason", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 500, nullable: true, comment: '失败摘要（已脱敏，长度上限）' }),
    __metadata("design:type", String)
], TelegramReplicationAttempt.prototype, "failureSummary", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0, comment: '合并窗口内累计重试次数' }),
    __metadata("design:type", Number)
], TelegramReplicationAttempt.prototype, "retryCount", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '执行中继的用户账号 ID（仅内部 ID）' }),
    __metadata("design:type", String)
], TelegramReplicationAttempt.prototype, "relayAccountId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, nullable: true, comment: '中继产生的群消息 ID（脱敏引用）' }),
    __metadata("design:type", String)
], TelegramReplicationAttempt.prototype, "relayMessageId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '本轮开始时间' }),
    __metadata("design:type", Date)
], TelegramReplicationAttempt.prototype, "startedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '中继完成时间' }),
    __metadata("design:type", Date)
], TelegramReplicationAttempt.prototype, "relayCompletedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '认领窗口截止时间' }),
    __metadata("design:type", Date)
], TelegramReplicationAttempt.prototype, "claimDeadlineAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '终态时间' }),
    __metadata("design:type", Date)
], TelegramReplicationAttempt.prototype, "completedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '下次可重试时间' }),
    __metadata("design:type", Date)
], TelegramReplicationAttempt.prototype, "nextRetryAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, default: 'lazy', comment: '触发来源：lazy|manual' }),
    __metadata("design:type", String)
], TelegramReplicationAttempt.prototype, "triggeredBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '手动重试操作人（仅内部 ID）' }),
    __metadata("design:type", String)
], TelegramReplicationAttempt.prototype, "operatorUserId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('uuid'), nullable: true, comment: '手动重试的来源轮次 ID' }),
    __metadata("design:type", String)
], TelegramReplicationAttempt.prototype, "retriedFromId", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ comment: '创建时间' }),
    __metadata("design:type", Date)
], TelegramReplicationAttempt.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)({ comment: '更新时间' }),
    __metadata("design:type", Date)
], TelegramReplicationAttempt.prototype, "updatedAt", void 0);
exports.TelegramReplicationAttempt = TelegramReplicationAttempt = __decorate([
    (0, typeorm_1.Entity)('telegram_replication_attempts'),
    (0, typeorm_1.Index)('idx_tg_replication_attempts_owner', ['ownerType', 'ownerId', 'createdAt']),
    (0, typeorm_1.Index)('idx_tg_replication_attempts_status', ['status']),
    (0, typeorm_1.Index)('idx_tg_replication_attempts_reason', ['failureReason']),
    (0, typeorm_1.Index)('idx_tg_replication_attempts_updated', ['updatedAt'])
], TelegramReplicationAttempt);
