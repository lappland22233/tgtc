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
exports.JwtRevokedToken = void 0;
const typeorm_1 = require("typeorm");
const database_types_1 = require("../../database/database-types");
let JwtRevokedToken = class JwtRevokedToken {
};
exports.JwtRevokedToken = JwtRevokedToken;
__decorate([
    (0, typeorm_1.PrimaryColumn)({ type: 'varchar', length: 64 }),
    __metadata("design:type", String)
], JwtRevokedToken.prototype, "jti", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('uuid'), nullable: true }),
    __metadata("design:type", String)
], JwtRevokedToken.prototype, "userId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamp') }),
    __metadata("design:type", Date)
], JwtRevokedToken.prototype, "expiresAt", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], JwtRevokedToken.prototype, "revokedAt", void 0);
exports.JwtRevokedToken = JwtRevokedToken = __decorate([
    (0, typeorm_1.Entity)('jwt_revoked_tokens'),
    (0, typeorm_1.Index)('IDX_jwt_revoked_tokens_expiresAt', ['expiresAt'])
], JwtRevokedToken);
