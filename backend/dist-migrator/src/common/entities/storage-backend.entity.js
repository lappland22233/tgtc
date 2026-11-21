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
exports.StorageBackend = void 0;
const database_types_1 = require("../../database/database-types");
const typeorm_1 = require("typeorm");
/**
 * 存储后端账号主数据（每行 = 一个存储账号/端点）。
 *
 * 为什么需要这张表：存储不再限于 Telegram——S3 一套密钥、WebDAV 一个端点、
 * GDrive 一个 Google 账号都是一行「存储账号」，由通用调度器按
 * 「带宽 × 健康度 × 容量 × 权重（× 剩余配额）」选号，实现账号池扩容。
 *
 * 安全约束（与 telegram_accounts 同口径）：
 * - **只存密文**：`credentialCiphertext` 为 AES-256-GCM 密文（独立根密钥
 *   `STORAGE_ENCRYPTION_KEY`），永不对外序列化；接口、审计、日志一律不得出现
 *   明文密钥 / refresh_token；
 * - `(type, name)` 唯一：同一后端类型下不允许重名账号；
 * - 撤销（revoked）只清凭据停任务，不删行——存量文件仍引用该账号，
 *   回源侧按 fail-closed 返回可诊断失败，绝不跨账号猜测。
 */
let StorageBackend = class StorageBackend {
};
exports.StorageBackend = StorageBackend;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], StorageBackend.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, comment: '后端类型：s3|webdav|gdrive' }),
    __metadata("design:type", String)
], StorageBackend.prototype, "type", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, comment: '管理员可读名称' }),
    __metadata("design:type", String)
], StorageBackend.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, default: 'active', comment: '生命周期状态' }),
    __metadata("design:type", String)
], StorageBackend.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'boolean', default: false, comment: '是否允许参与新任务' }),
    __metadata("design:type", Boolean)
], StorageBackend.prototype, "enabled", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 1, comment: '调度静态权重' }),
    __metadata("design:type", Number)
], StorageBackend.prototype, "weight", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 8, comment: '每账号在飞上限' }),
    __metadata("design:type", Number)
], StorageBackend.prototype, "maxInflight", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('jsonb'), nullable: true, comment: '后端配置（非敏感）' }),
    __metadata("design:type", Object)
], StorageBackend.prototype, "config", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true, comment: '加密凭据（AES-256-GCM，永不回显）', select: false }),
    __metadata("design:type", String)
], StorageBackend.prototype, "credentialCiphertext", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, nullable: true, comment: '凭据密文版本' }),
    __metadata("design:type", String)
], StorageBackend.prototype, "credentialVersion", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'bigint', nullable: true, comment: '配额上限（字节），null=无限制' }),
    __metadata("design:type", Number)
], StorageBackend.prototype, "quotaTotalBytes", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'bigint', nullable: true, comment: '已用配额（字节）' }),
    __metadata("design:type", Number)
], StorageBackend.prototype, "quotaUsedBytes", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '最近配额刷新时间' }),
    __metadata("design:type", Date)
], StorageBackend.prototype, "lastQuotaCheckAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '最近健康检查时间' }),
    __metadata("design:type", Date)
], StorageBackend.prototype, "lastHealthCheckAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '最近成功时间' }),
    __metadata("design:type", Date)
], StorageBackend.prototype, "lastSuccessAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz'), nullable: true, comment: '最近失败时间' }),
    __metadata("design:type", Date)
], StorageBackend.prototype, "lastFailureAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '最近失败分类（脱敏）' }),
    __metadata("design:type", String)
], StorageBackend.prototype, "lastFailureCode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 500, nullable: true, comment: '最近失败摘要（脱敏）' }),
    __metadata("design:type", String)
], StorageBackend.prototype, "lastFailureSummary", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 255, nullable: true, comment: '管理员备注' }),
    __metadata("design:type", String)
], StorageBackend.prototype, "note", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '创建人（管理员用户 ID）' }),
    __metadata("design:type", String)
], StorageBackend.prototype, "createdBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true, comment: '最近修改人（管理员用户 ID）' }),
    __metadata("design:type", String)
], StorageBackend.prototype, "updatedBy", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ comment: '创建时间' }),
    __metadata("design:type", Date)
], StorageBackend.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)({ comment: '更新时间' }),
    __metadata("design:type", Date)
], StorageBackend.prototype, "updatedAt", void 0);
exports.StorageBackend = StorageBackend = __decorate([
    (0, typeorm_1.Entity)('storage_backends'),
    (0, typeorm_1.Index)('uq_storage_backends_type_name', ['type', 'name'], { unique: true }),
    (0, typeorm_1.Index)('idx_storage_backends_status', ['status']),
    (0, typeorm_1.Index)('idx_storage_backends_enabled', ['enabled'])
], StorageBackend);
