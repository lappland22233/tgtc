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
exports.BannedIP = void 0;
const database_types_1 = require("../../database/database-types");
const typeorm_1 = require("typeorm");
let BannedIP = class BannedIP {
};
exports.BannedIP = BannedIP;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], BannedIP.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ unique: true }),
    __metadata("design:type", String)
], BannedIP.prototype, "ip", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'varchar' }),
    __metadata("design:type", String)
], BannedIP.prototype, "reason", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: false }),
    __metadata("design:type", Boolean)
], BannedIP.prototype, "isPermanent", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('timestamp') }),
    __metadata("design:type", Date)
], BannedIP.prototype, "expiresAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('timestamp'), name: 'unbanned_at' }),
    __metadata("design:type", Date)
], BannedIP.prototype, "unbannedAt", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], BannedIP.prototype, "createdAt", void 0);
exports.BannedIP = BannedIP = __decorate([
    (0, typeorm_1.Entity)('banned_ips'),
    (0, typeorm_1.Check)('CHK_banned_ips_permanence_expiry', '("isPermanent" = true AND "expiresAt" IS NULL) OR ("isPermanent" = false AND "expiresAt" IS NOT NULL)')
], BannedIP);
