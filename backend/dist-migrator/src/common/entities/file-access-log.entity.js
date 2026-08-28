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
exports.FileAccessLog = exports.AccessAction = void 0;
const typeorm_1 = require("typeorm");
const file_entity_1 = require("./file.entity");
var AccessAction;
(function (AccessAction) {
    AccessAction["DOWNLOAD"] = "download";
    AccessAction["PUBLIC_SHARE"] = "public_share";
    AccessAction["PREVIEW"] = "preview";
})(AccessAction || (exports.AccessAction = AccessAction = {}));
let FileAccessLog = class FileAccessLog {
};
exports.FileAccessLog = FileAccessLog;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], FileAccessLog.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => file_entity_1.File),
    (0, typeorm_1.JoinColumn)({ name: 'fileId' }),
    __metadata("design:type", file_entity_1.File)
], FileAccessLog.prototype, "file", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    (0, typeorm_1.Index)(),
    __metadata("design:type", String)
], FileAccessLog.prototype, "fileId", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], FileAccessLog.prototype, "ip", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 50 }),
    __metadata("design:type", String)
], FileAccessLog.prototype, "action", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], FileAccessLog.prototype, "uploaderId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'bigint', default: 0, comment: '实际传输字节数（带宽精确统计）' }),
    __metadata("design:type", Number)
], FileAccessLog.prototype, "responseSize", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], FileAccessLog.prototype, "createdAt", void 0);
exports.FileAccessLog = FileAccessLog = __decorate([
    (0, typeorm_1.Entity)('file_access_logs'),
    (0, typeorm_1.Index)('idx_access_logs_uploader_created', ['uploaderId', 'createdAt']),
    (0, typeorm_1.Index)('idx_access_logs_file_created', ['fileId', 'createdAt'])
    // G8-13：支持按 action + 时间窗口的扫描（异常下载/分享检测、归档清理走索引）
    ,
    (0, typeorm_1.Index)('idx_access_logs_action_created', ['action', 'createdAt'])
], FileAccessLog);
