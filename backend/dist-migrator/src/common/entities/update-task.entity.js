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
exports.UpdateTask = void 0;
const database_types_1 = require("../../database/database-types");
const typeorm_1 = require("typeorm");
/** 保留 1.x 历史记录的表结构，供 PostgreSQL 到 SQLite 的离线迁移使用。 */
let UpdateTask = class UpdateTask {
};
exports.UpdateTask = UpdateTask;
__decorate([
    (0, typeorm_1.PrimaryColumn)({ type: (0, database_types_1.databaseColumnType)('uuid') }),
    __metadata("design:type", String)
], UpdateTask.prototype, "taskId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('uuid') }),
    __metadata("design:type", String)
], UpdateTask.prototype, "requestedBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32 }),
    __metadata("design:type", String)
], UpdateTask.prototype, "currentVersion", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32 }),
    __metadata("design:type", String)
], UpdateTask.prototype, "targetVersion", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int' }),
    __metadata("design:type", Number)
], UpdateTask.prototype, "releaseId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64 }),
    __metadata("design:type", String)
], UpdateTask.prototype, "releaseTag", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 24, default: 'queued' }),
    __metadata("design:type", String)
], UpdateTask.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0 }),
    __metadata("design:type", Number)
], UpdateTask.prototype, "progress", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: true }),
    __metadata("design:type", Boolean)
], UpdateTask.prototype, "isActive", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'varchar', length: 64 }),
    __metadata("design:type", String)
], UpdateTask.prototype, "errorCode", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'text' }),
    __metadata("design:type", String)
], UpdateTask.prototype, "errorSummary", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'varchar', length: 24 }),
    __metadata("design:type", String)
], UpdateTask.prototype, "rollbackStatus", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('jsonb'), nullable: true }),
    __metadata("design:type", Object)
], UpdateTask.prototype, "metadata", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('timestamptz') }),
    __metadata("design:type", Date)
], UpdateTask.prototype, "startedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('timestamptz') }),
    __metadata("design:type", Date)
], UpdateTask.prototype, "finishedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('timestamptz') }),
    __metadata("design:type", Date)
], UpdateTask.prototype, "heartbeatAt", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], UpdateTask.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], UpdateTask.prototype, "updatedAt", void 0);
exports.UpdateTask = UpdateTask = __decorate([
    (0, typeorm_1.Entity)('update_tasks'),
    (0, typeorm_1.Index)('idx_update_tasks_createdAt', ['createdAt']),
    (0, typeorm_1.Index)('uq_update_tasks_active_slot', ['isActive'], { unique: true, where: '"isActive" = true' })
], UpdateTask);
