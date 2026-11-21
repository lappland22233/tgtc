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
exports.ApiKeyIpAllowlist = void 0;
const typeorm_1 = require("typeorm");
const database_types_1 = require("../../database/database-types");
/**
 * API 密钥 IP 白名单（v1.2.6，按每把密钥独立配置）。
 *
 * - 规则支持单 IP（IPv4/IPv6）与 CIDR（IPv4: /0-/32，IPv6: /0-/128）；
 * - 空名单 = 不限制来源；
 * - 认证链路在校验密钥身份后、授予请求上下文前执行匹配，
 *   不命中即拒绝（401，不暴露密钥有效性细节）并记录使用日志。
 */
let ApiKeyIpAllowlist = class ApiKeyIpAllowlist {
};
exports.ApiKeyIpAllowlist = ApiKeyIpAllowlist;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], ApiKeyIpAllowlist.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('uuid') }),
    __metadata("design:type", String)
], ApiKeyIpAllowlist.prototype, "apiKeyId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64 }),
    __metadata("design:type", String)
], ApiKeyIpAllowlist.prototype, "rule", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], ApiKeyIpAllowlist.prototype, "createdAt", void 0);
exports.ApiKeyIpAllowlist = ApiKeyIpAllowlist = __decorate([
    (0, typeorm_1.Entity)('api_key_ip_allowlist'),
    (0, typeorm_1.Index)('idx_api_key_ip_allowlist_keyId', ['apiKeyId'])
], ApiKeyIpAllowlist);
