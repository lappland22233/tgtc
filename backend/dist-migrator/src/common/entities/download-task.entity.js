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
exports.DownloadTask = void 0;
const typeorm_1 = require("typeorm");
const database_types_1 = require("../../database/database-types");
/**
 * 下载任务（持久化）。
 *
 * 设计边界：
 * - 内存中的任务表仍是运行时的权威来源（排队位置、预约量等只在进程内有效）；
 *   本实体只持久化「任务是否曾经存在 + 最终状态」，用于服务重启后把未完成任务
 *   标记为过期（前端据此重新发起），以及过期记录清理。
 * - 只保存 ownerKey（`user:<id>` / `share:<token-hash 前缀>`），不落库分享 token 明文。
 * - 不保存文件内容或本地临时路径：临时文件由缓存会话负责回收，重启后本就无需保留。
 */
let DownloadTask = class DownloadTask {
};
exports.DownloadTask = DownloadTask;
__decorate([
    (0, typeorm_1.PrimaryColumn)('uuid'),
    __metadata("design:type", String)
], DownloadTask.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Index)('idx_download_tasks_owner'),
    (0, typeorm_1.Column)({ type: 'varchar', length: 128 }),
    __metadata("design:type", String)
], DownloadTask.prototype, "ownerKey", void 0);
__decorate([
    (0, typeorm_1.Index)('idx_download_tasks_file'),
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('uuid') }),
    __metadata("design:type", String)
], DownloadTask.prototype, "fileId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 255, nullable: true }),
    __metadata("design:type", String)
], DownloadTask.prototype, "fileName", void 0);
__decorate([
    (0, typeorm_1.Index)('idx_download_tasks_status'),
    (0, typeorm_1.Column)({ type: 'varchar', length: 16 }),
    __metadata("design:type", String)
], DownloadTask.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, nullable: true }),
    __metadata("design:type", String)
], DownloadTask.prototype, "queueReason", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true }),
    __metadata("design:type", String)
], DownloadTask.prototype, "errorCode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'bigint', default: 0 }),
    __metadata("design:type", String)
], DownloadTask.prototype, "expectedSize", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], DownloadTask.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], DownloadTask.prototype, "updatedAt", void 0);
__decorate([
    (0, typeorm_1.Index)('idx_download_tasks_expires'),
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamptz') }),
    __metadata("design:type", Date)
], DownloadTask.prototype, "expiresAt", void 0);
exports.DownloadTask = DownloadTask = __decorate([
    (0, typeorm_1.Entity)('download_tasks')
], DownloadTask);
