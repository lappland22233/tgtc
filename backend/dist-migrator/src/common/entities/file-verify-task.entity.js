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
exports.FileVerifyTask = exports.FILE_VERIFY_ACTIVE_STATUSES = void 0;
const database_types_1 = require("../../database/database-types");
const typeorm_1 = require("typeorm");
/** 备用：活动任务的状态集合（queued / running） */
exports.FILE_VERIFY_ACTIVE_STATUSES = ['queued', 'running'];
/**
 * 文件体检异步任务持久化实体
 * 用于在后台通过 Bull 队列执行文件体检，并将进度/统计持久化，支持查询进度。
 * 同一时间全局最多 1 个活动任务（queued/running），由数据库部分唯一索引保证。
 */
let FileVerifyTask = class FileVerifyTask {
};
exports.FileVerifyTask = FileVerifyTask;
__decorate([
    (0, typeorm_1.PrimaryColumn)({ type: (0, database_types_1.databaseColumnType)('uuid') }),
    __metadata("design:type", String)
], FileVerifyTask.prototype, "taskId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('uuid') }),
    __metadata("design:type", String)
], FileVerifyTask.prototype, "createdBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, default: 'dry-run' }),
    __metadata("design:type", String)
], FileVerifyTask.prototype, "mode", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: false }),
    __metadata("design:type", Boolean)
], FileVerifyTask.prototype, "allReady", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 500 }),
    __metadata("design:type", Number)
], FileVerifyTask.prototype, "limit", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 4 }),
    __metadata("design:type", Number)
], FileVerifyTask.prototype, "concurrency", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: true }),
    __metadata("design:type", Boolean)
], FileVerifyTask.prototype, "isActive", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, default: 'queued' }),
    __metadata("design:type", String)
], FileVerifyTask.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0 }),
    __metadata("design:type", Number)
], FileVerifyTask.prototype, "totalCandidates", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0 }),
    __metadata("design:type", Number)
], FileVerifyTask.prototype, "processed", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0 }),
    __metadata("design:type", Number)
], FileVerifyTask.prototype, "valid", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0 }),
    __metadata("design:type", Number)
], FileVerifyTask.prototype, "invalid", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0 }),
    __metadata("design:type", Number)
], FileVerifyTask.prototype, "emptyFileId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0 }),
    __metadata("design:type", Number)
], FileVerifyTask.prototype, "temporaryFailure", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0 }),
    __metadata("design:type", Number)
], FileVerifyTask.prototype, "sizeMismatch", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0 }),
    __metadata("design:type", Number)
], FileVerifyTask.prototype, "backfilled", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0 }),
    __metadata("design:type", Number)
], FileVerifyTask.prototype, "markedError", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'text' }),
    __metadata("design:type", String)
], FileVerifyTask.prototype, "errorSummary", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('timestamptz') }),
    __metadata("design:type", Date)
], FileVerifyTask.prototype, "startedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('timestamptz') }),
    __metadata("design:type", Date)
], FileVerifyTask.prototype, "completedAt", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], FileVerifyTask.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], FileVerifyTask.prototype, "updatedAt", void 0);
exports.FileVerifyTask = FileVerifyTask = __decorate([
    (0, typeorm_1.Entity)('file_verify_tasks'),
    (0, typeorm_1.Index)('idx_file_verify_tasks_createdAt', ['createdAt']),
    (0, typeorm_1.Index)('uq_file_verify_tasks_active_slot', ['isActive'], { unique: true, where: '"isActive" = true' })
], FileVerifyTask);
