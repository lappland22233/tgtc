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
exports.VerificationCode = void 0;
const database_types_1 = require("../../database/database-types");
const typeorm_1 = require("typeorm");
let VerificationCode = class VerificationCode {
};
exports.VerificationCode = VerificationCode;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], VerificationCode.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], VerificationCode.prototype, "email", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 64, comment: 'SHA256 hashed verification code' }),
    __metadata("design:type", String)
], VerificationCode.prototype, "code", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], VerificationCode.prototype, "type", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: false }),
    __metadata("design:type", Boolean)
], VerificationCode.prototype, "isUsed", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamp') }),
    __metadata("design:type", Date)
], VerificationCode.prototype, "expiresAt", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], VerificationCode.prototype, "createdAt", void 0);
exports.VerificationCode = VerificationCode = __decorate([
    (0, typeorm_1.Entity)('verification_codes'),
    (0, typeorm_1.Index)('IDX_verification_codes_email_type_isUsed_expiresAt', ['email', 'type', 'isUsed', 'expiresAt'])
], VerificationCode);
