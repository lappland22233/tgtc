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
exports.AccessLog = void 0;
const database_types_1 = require("../../database/database-types");
const typeorm_1 = require("typeorm");
let AccessLog = class AccessLog {
};
exports.AccessLog = AccessLog;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], AccessLog.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)({ comment: '客户端 IP 地址' }),
    __metadata("design:type", String)
], AccessLog.prototype, "ip", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 10, comment: 'HTTP 方法' }),
    __metadata("design:type", String)
], AccessLog.prototype, "method", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 500, comment: '请求路径' }),
    __metadata("design:type", String)
], AccessLog.prototype, "path", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', comment: 'HTTP 状态码' }),
    __metadata("design:type", Number)
], AccessLog.prototype, "statusCode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'bigint', default: 0, comment: '响应体大小（字节），用于带宽统计' }),
    __metadata("design:type", Number)
], AccessLog.prototype, "responseSize", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0, comment: '请求耗时（毫秒）' }),
    __metadata("design:type", Number)
], AccessLog.prototype, "duration", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'varchar', length: 500, comment: 'User-Agent' }),
    __metadata("design:type", String)
], AccessLog.prototype, "userAgent", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'varchar', length: 300, comment: 'Referer' }),
    __metadata("design:type", String)
], AccessLog.prototype, "referer", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('uuid'), comment: '关联用户 ID（已登录请求）' }),
    __metadata("design:type", String)
], AccessLog.prototype, "userId", void 0);
__decorate([
    (0, typeorm_1.Index)('IDX_access_logs_botGrantId'),
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('uuid'), comment: 'Bot 直链 grant ID' }),
    __metadata("design:type", String)
], AccessLog.prototype, "botGrantId", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'varchar', length: 32, comment: 'Bot 下载者 TG 用户 ID' }),
    __metadata("design:type", String)
], AccessLog.prototype, "botTelegramUserId", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'boolean', comment: '下载传输是否完整写完响应' }),
    __metadata("design:type", Boolean)
], AccessLog.prototype, "transferCompleted", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'boolean', comment: '下载传输是否被中断' }),
    __metadata("design:type", Boolean)
], AccessLog.prototype, "transferAborted", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'boolean', comment: '是否 Range 分段响应' }),
    __metadata("design:type", Boolean)
], AccessLog.prototype, "ranged", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'varchar', length: 24, comment: '传输结束原因' }),
    __metadata("design:type", String)
], AccessLog.prototype, "terminationReason", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'bigint', comment: '实际响应体字节（bigint 字符串）' }),
    __metadata("design:type", String)
], AccessLog.prototype, "responseBodyBytes", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ comment: '请求时间' }),
    __metadata("design:type", Date)
], AccessLog.prototype, "createdAt", void 0);
exports.AccessLog = AccessLog = __decorate([
    (0, typeorm_1.Entity)('access_logs'),
    (0, typeorm_1.Index)(['createdAt']),
    (0, typeorm_1.Index)(['path']),
    (0, typeorm_1.Index)(['statusCode'])
    // 组合查询（时间范围 + IP / 时间范围 + 状态码）的复合索引，优于独立单列索引（P2）
    ,
    (0, typeorm_1.Index)('IDX_access_logs_createdAt_ip', ['createdAt', 'ip']),
    (0, typeorm_1.Index)('IDX_access_logs_createdAt_statusCode', ['createdAt', 'statusCode'])
], AccessLog);
