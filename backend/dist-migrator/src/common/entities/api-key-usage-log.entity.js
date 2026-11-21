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
exports.ApiKeyUsageLog = exports.ApiKeyUsageResult = void 0;
const typeorm_1 = require("typeorm");
const database_types_1 = require("../../database/database-types");
/** API 密钥使用结果 */
var ApiKeyUsageResult;
(function (ApiKeyUsageResult) {
    /** 允许 */
    ApiKeyUsageResult["ALLOWED"] = "allowed";
    /** IP 白名单拒绝 */
    ApiKeyUsageResult["DENIED_IP"] = "denied_ip";
})(ApiKeyUsageResult || (exports.ApiKeyUsageResult = ApiKeyUsageResult = {}));
/**
 * API 密钥使用审计（v1.2.6）。
 *
 * - 记录每次经 API Key 认证的调用：时间、方法、路由、结果状态、可信客户端 IP；
 * - 由认证 Guard 之后的拦截器写入（AccessLogMiddleware 发生在 Guard 之前，
 *   无法可靠归因 API Key 身份）；白名单拒绝由认证链路直接写入；
 * - 保留上限 7 天，由定时任务清理，不复用 30 天访问日志留存策略；
 * - 所有者查询时 IP 脱敏（仅首段 + 末段）；明文 IP 仅管理端审计可见。
 */
let ApiKeyUsageLog = class ApiKeyUsageLog {
};
exports.ApiKeyUsageLog = ApiKeyUsageLog;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], ApiKeyUsageLog.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('uuid') }),
    __metadata("design:type", String)
], ApiKeyUsageLog.prototype, "apiKeyId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('uuid') }),
    __metadata("design:type", String)
], ApiKeyUsageLog.prototype, "userId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 10 }),
    __metadata("design:type", String)
], ApiKeyUsageLog.prototype, "method", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 255 }),
    __metadata("design:type", String)
], ApiKeyUsageLog.prototype, "route", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 20, default: ApiKeyUsageResult.ALLOWED }),
    __metadata("design:type", String)
], ApiKeyUsageLog.prototype, "result", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', nullable: true }),
    __metadata("design:type", Number)
], ApiKeyUsageLog.prototype, "statusCode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64 }),
    __metadata("design:type", String)
], ApiKeyUsageLog.prototype, "ip", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], ApiKeyUsageLog.prototype, "createdAt", void 0);
exports.ApiKeyUsageLog = ApiKeyUsageLog = __decorate([
    (0, typeorm_1.Entity)('api_key_usage_logs'),
    (0, typeorm_1.Index)('idx_api_key_usage_logs_keyId_createdAt', ['apiKeyId', 'createdAt']),
    (0, typeorm_1.Index)('idx_api_key_usage_logs_userId_createdAt', ['userId', 'createdAt']),
    (0, typeorm_1.Index)('idx_api_key_usage_logs_createdAt', ['createdAt'])
], ApiKeyUsageLog);
