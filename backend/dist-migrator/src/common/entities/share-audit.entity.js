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
exports.ShareAudit = void 0;
const typeorm_1 = require("typeorm");
let ShareAudit = class ShareAudit {
};
exports.ShareAudit = ShareAudit;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], ShareAudit.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ unique: true }),
    __metadata("design:type", String)
], ShareAudit.prototype, "jti", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], ShareAudit.prototype, "fileId", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, comment: '访问者ID，匿名访问可为空' }),
    __metadata("design:type", String)
], ShareAudit.prototype, "userId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', default: 'consume' }),
    __metadata("design:type", String)
], ShareAudit.prototype, "action", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, default: '' }),
    __metadata("design:type", String)
], ShareAudit.prototype, "ip", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], ShareAudit.prototype, "createdAt", void 0);
exports.ShareAudit = ShareAudit = __decorate([
    (0, typeorm_1.Entity)('share_audits'),
    (0, typeorm_1.Index)('idx_share_audits_createdAt', ['createdAt'])
], ShareAudit);
