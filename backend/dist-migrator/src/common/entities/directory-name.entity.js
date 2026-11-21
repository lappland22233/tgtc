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
exports.DirectoryName = void 0;
const typeorm_1 = require("typeorm");
const database_types_1 = require("../../database/database-types");
/**
 * 统一目录命名空间表（v1.2.6）。
 *
 * 背景：files 与 folders 是两张独立的表，任何单表唯一索引都无法阻止
 * 「同目录下文件与文件夹重名」；服务层 findOne 预检查在并发上传/创建时
 * 存在 TOCTOU 竞态。本表是跨表名称唯一性的最终裁决层：
 *
 * - 唯一约束 (ownerId, scopeKey, nameKey)（仅对 isDeleted=false 生效，
 *   PG 部分唯一索引 / SQLite 部分唯一索引均支持）；
 * - nameKey = 名称 Unicode NFC 归一化 + 小写折叠，实现大小写不敏感判定；
 * - scopeKey = 目录 ID，根目录用固定哨兵值 '__root__'，规避 NULL 索引语义差异；
 * - 软删除实体时置 isDeleted=true 释放名称；物理删除时删除行；
 * - 恢复时重新置 isDeleted=false，与其他活跃名称冲突即失败。
 */
let DirectoryName = class DirectoryName {
};
exports.DirectoryName = DirectoryName;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], DirectoryName.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('uuid') }),
    __metadata("design:type", String)
], DirectoryName.prototype, "ownerId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64 }),
    __metadata("design:type", String)
], DirectoryName.prototype, "scopeKey", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 255 }),
    __metadata("design:type", String)
], DirectoryName.prototype, "nameKey", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 10 }),
    __metadata("design:type", String)
], DirectoryName.prototype, "entityType", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('uuid') }),
    __metadata("design:type", String)
], DirectoryName.prototype, "entityId", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: false }),
    __metadata("design:type", Boolean)
], DirectoryName.prototype, "isDeleted", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], DirectoryName.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], DirectoryName.prototype, "updatedAt", void 0);
exports.DirectoryName = DirectoryName = __decorate([
    (0, typeorm_1.Entity)('directory_names'),
    (0, typeorm_1.Index)('uq_directory_names_active', ['ownerId', 'scopeKey', 'nameKey'], {
        unique: true,
        where: '"isDeleted" = false',
    }),
    (0, typeorm_1.Index)('idx_directory_names_entity', ['entityType', 'entityId'])
], DirectoryName);
