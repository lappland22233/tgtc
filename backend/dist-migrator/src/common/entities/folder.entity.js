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
exports.Folder = void 0;
const typeorm_1 = require("typeorm");
const user_entity_1 = require("./user.entity");
const database_types_1 = require("../../database/database-types");
/**
 * 文件夹实体（网盘层级）。
 *
 * 采用闭包表（closure-table）存储层级关系，TypeORM 原生 @Tree('closure-table') 支持。
 * folderId = null 的 File 视为位于用户网盘根目录，与历史数据兼容。
 *
 * 软删除策略与 files 表一致：标记 isDeleted=true，7 天延迟后由清理任务物理删除。
 */
let Folder = class Folder {
};
exports.Folder = Folder;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], Folder.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 255 }),
    __metadata("design:type", String)
], Folder.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => user_entity_1.User, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'ownerId' }),
    __metadata("design:type", user_entity_1.User)
], Folder.prototype, "owner", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], Folder.prototype, "ownerId", void 0);
__decorate([
    (0, typeorm_1.TreeParent)(),
    __metadata("design:type", Folder)
], Folder.prototype, "parent", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], Folder.prototype, "parentId", void 0);
__decorate([
    (0, typeorm_1.TreeChildren)(),
    __metadata("design:type", Array)
], Folder.prototype, "children", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: false }),
    __metadata("design:type", Boolean)
], Folder.prototype, "isDeleted", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('timestamp') }),
    __metadata("design:type", Date)
], Folder.prototype, "deleteRequestedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('timestamp') }),
    __metadata("design:type", Date)
], Folder.prototype, "deleteScheduledAt", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], Folder.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], Folder.prototype, "updatedAt", void 0);
exports.Folder = Folder = __decorate([
    (0, typeorm_1.Entity)('folders')
    // closureTableName 必须显式指定：TypeORM 默认按实体表名解析闭包联结表（即 folders_closure），
    // 但迁移 1790400000000-AddFoldersTable 实际建的表是 folder_closure（synchronize=false，不会自动建表）。
    // 指定 closureTableName: 'folder' 后 TypeORM 拼 `_closure` 后缀解析为 folder_closure，与迁移及裸 SQL 对齐。
    ,
    (0, typeorm_1.Tree)('closure-table', { closureTableName: 'folder' }),
    (0, typeorm_1.Index)('idx_folders_owner_parent_deleted', ['ownerId', 'parentId', 'isDeleted'])
    // G6-06/G6-13：与迁移 1798100000001-AddFolderSameLevelUniqueIndex 对齐——
    // 同层（ownerId + parentId）下未删除文件夹 name 唯一（部分唯一索引）。
    // TypeORM @Index where 即 SQL 的 WHERE 子句（PostgreSQL 部分索引）。
    ,
    (0, typeorm_1.Index)('uq_folders_owner_parent_name_active', ['ownerId', 'parentId', 'name'], {
        unique: true,
        where: '"isDeleted" = false',
    })
], Folder);
