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
exports.Alert = exports.AlertLevel = void 0;
const database_types_1 = require("../../database/database-types");
const typeorm_1 = require("typeorm");
var AlertLevel;
(function (AlertLevel) {
    AlertLevel["INFO"] = "info";
    AlertLevel["WARNING"] = "warning";
    AlertLevel["CRITICAL"] = "critical";
})(AlertLevel || (exports.AlertLevel = AlertLevel = {}));
let Alert = class Alert {
};
exports.Alert = Alert;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], Alert.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 100 }),
    __metadata("design:type", String)
], Alert.prototype, "ruleId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 20, default: AlertLevel.INFO }),
    __metadata("design:type", String)
], Alert.prototype, "level", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 255 }),
    __metadata("design:type", String)
], Alert.prototype, "title", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", String)
], Alert.prototype, "message", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('jsonb'), nullable: true }),
    __metadata("design:type", Object)
], Alert.prototype, "context", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('timestamptz') }),
    __metadata("design:type", Date)
], Alert.prototype, "acknowledgedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'uuid' }),
    __metadata("design:type", String)
], Alert.prototype, "acknowledgedBy", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ type: (0, database_types_1.databaseColumnType)('timestamptz') }),
    __metadata("design:type", Date)
], Alert.prototype, "createdAt", void 0);
exports.Alert = Alert = __decorate([
    (0, typeorm_1.Entity)('alerts'),
    (0, typeorm_1.Index)(['ruleId', 'createdAt'])
    // 未确认告警查询（acknowledgedAt IS NULL）的部分索引：
    // IDX_alerts_acknowledged 已由迁移 1785000000000 创建，此处声明使实体与库 schema 一致；
    // IDX_alerts_unacknowledged_createdAt 直接服务「未确认 + 按时间倒序」的常见查询。
    ,
    (0, typeorm_1.Index)('IDX_alerts_acknowledged', ['acknowledgedAt'], { where: '"acknowledgedAt" IS NULL' }),
    (0, typeorm_1.Index)('IDX_alerts_unacknowledged_createdAt', ['createdAt'], { where: '"acknowledgedAt" IS NULL' })
], Alert);
