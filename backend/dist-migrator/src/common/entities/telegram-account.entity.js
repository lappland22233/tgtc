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
exports.TelegramAccount = void 0;
const database_types_1 = require("../../database/database-types");
const typeorm_1 = require("typeorm");
/**
 * Telegram 账号主数据（Bot 与用户账号统一建模）。
 *
 * 为什么需要这张表：账号池当前只能从环境变量解析账号，管理员无法在后台查看、
 * 添加、停用或轮换账号，也无法记录健康与能力状态。环境变量从此只保留
 * 「首次默认值 + 紧急强制关闭」语义，日常运营以本表为事实来源。
 *
 * 安全约束：
 * - **只存密文**：`credentialCiphertext` 为 AES-256-GCM 密文，永不对外序列化；
 *   接口、审计、日志、异常与前端状态中一律不得出现明文 Token/session/验证码；
 * - `externalId` 允许为空（用户账号授权完成前未知），返回时脱敏；
 * - `(type, externalId)` 唯一：同一 Bot / 同一 Telegram 用户不允许重复登记。
 */
let TelegramAccount = class TelegramAccount {
};
exports.TelegramAccount = TelegramAccount;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], TelegramAccount.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 8, comment: '账号类型：bot|user' }),
    __metadata("design:type", String)
], TelegramAccount.prototype, "type", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, comment: '管理员可读名称' }),
    __metadata("design:type", String)
], TelegramAccount.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '外部标识（Bot ID / TG 用户 ID），脱敏返回' }),
    __metadata("design:type", String)
], TelegramAccount.prototype, "externalId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, default: 'pending_auth', comment: '生命周期状态' }),
    __metadata("design:type", String)
], TelegramAccount.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'boolean', default: false, comment: '是否允许参与新任务' }),
    __metadata("design:type", Boolean)
], TelegramAccount.prototype, "enabled", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 1, comment: '调度静态权重' }),
    __metadata("design:type", Number)
], TelegramAccount.prototype, "weight", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 16, comment: '每账号在飞上限' }),
    __metadata("design:type", Number)
], TelegramAccount.prototype, "maxInflight", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, nullable: true, comment: '主存储 Chat / 可选源 Chat' }),
    __metadata("design:type", String)
], TelegramAccount.prototype, "primaryChatId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true, comment: '加密凭据（AES-256-GCM，永不回显）', select: false }),
    __metadata("design:type", String)
], TelegramAccount.prototype, "credentialCiphertext", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, nullable: true, comment: '凭据密文版本' }),
    __metadata("design:type", String)
], TelegramAccount.prototype, "credentialVersion", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('jsonb'), nullable: true, comment: '能力快照（测试结论）' }),
    __metadata("design:type", Object)
], TelegramAccount.prototype, "capabilities", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '最近健康检查时间' }),
    __metadata("design:type", Date)
], TelegramAccount.prototype, "lastHealthCheckAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '最近成功时间' }),
    __metadata("design:type", Date)
], TelegramAccount.prototype, "lastSuccessAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '最近失败时间' }),
    __metadata("design:type", Date)
], TelegramAccount.prototype, "lastFailureAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '最近失败分类（脱敏）' }),
    __metadata("design:type", String)
], TelegramAccount.prototype, "lastFailureCode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 500, nullable: true, comment: '最近失败摘要（脱敏）' }),
    __metadata("design:type", String)
], TelegramAccount.prototype, "lastFailureSummary", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 255, nullable: true, comment: '管理员备注（脱敏）' }),
    __metadata("design:type", String)
], TelegramAccount.prototype, "note", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '创建人（管理员用户 ID）' }),
    __metadata("design:type", String)
], TelegramAccount.prototype, "createdBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '最近修改人（管理员用户 ID）' }),
    __metadata("design:type", String)
], TelegramAccount.prototype, "updatedBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '停用时间' }),
    __metadata("design:type", Date)
], TelegramAccount.prototype, "disabledAt", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ comment: '创建时间' }),
    __metadata("design:type", Date)
], TelegramAccount.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)({ comment: '更新时间' }),
    __metadata("design:type", Date)
], TelegramAccount.prototype, "updatedAt", void 0);
exports.TelegramAccount = TelegramAccount = __decorate([
    (0, typeorm_1.Entity)('telegram_accounts'),
    (0, typeorm_1.Index)('uq_tg_accounts_type_external', ['type', 'externalId'], { unique: true }),
    (0, typeorm_1.Index)('idx_tg_accounts_status', ['status']),
    (0, typeorm_1.Index)('idx_tg_accounts_enabled', ['enabled'])
], TelegramAccount);
