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
exports.RateLimit = void 0;
const database_types_1 = require("../../database/database-types");
const typeorm_1 = require("typeorm");
let RateLimit = class RateLimit {
};
exports.RateLimit = RateLimit;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], RateLimit.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ unique: true }),
    __metadata("design:type", String)
], RateLimit.prototype, "key", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], RateLimit.prototype, "type", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: 1 }),
    __metadata("design:type", Number)
], RateLimit.prototype, "attemptCount", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamp'), default: () => (0, database_types_1.databaseCurrentTimestamp)() }),
    __metadata("design:type", Date)
], RateLimit.prototype, "firstAttemptAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('timestamp') }),
    __metadata("design:type", Date)
], RateLimit.prototype, "lockedUntil", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], RateLimit.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], RateLimit.prototype, "updatedAt", void 0);
exports.RateLimit = RateLimit = __decorate([
    (0, typeorm_1.Entity)('rate_limits'),
    (0, typeorm_1.Index)('IDX_rate_limits_lockedUntil', ['lockedUntil']),
    (0, typeorm_1.Index)('IDX_rate_limits_updatedAt', ['updatedAt'])
], RateLimit);
