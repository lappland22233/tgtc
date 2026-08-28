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
exports.File = exports.FileAccessType = void 0;
const typeorm_1 = require("typeorm");
const user_entity_1 = require("./user.entity");
const database_types_1 = require("../../database/database-types");
const folder_entity_1 = require("./folder.entity");
var FileAccessType;
(function (FileAccessType) {
    FileAccessType["PUBLIC"] = "public";
    FileAccessType["PRIVATE"] = "private";
})(FileAccessType || (exports.FileAccessType = FileAccessType = {}));
let File = class File {
};
exports.File = File;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], File.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], File.prototype, "filename", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], File.prototype, "originalName", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], File.prototype, "mimeType", void 0);
__decorate([
    (0, typeorm_1.Column)('bigint'),
    __metadata("design:type", Number)
], File.prototype, "size", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], File.prototype, "telegramFileId", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], File.prototype, "telegramFilePath", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 512, nullable: true, default: null }),
    __metadata("design:type", String)
], File.prototype, "thumbnailPath", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], File.prototype, "folderId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => folder_entity_1.Folder, { nullable: true, onDelete: 'SET NULL' }),
    (0, typeorm_1.JoinColumn)({ name: 'folderId' }),
    __metadata("design:type", folder_entity_1.Folder)
], File.prototype, "folder", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('enum'), enum: FileAccessType, default: FileAccessType.PUBLIC }),
    __metadata("design:type", String)
], File.prototype, "accessType", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: -1 }),
    __metadata("design:type", Number)
], File.prototype, "maxAccessCount", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'int' }),
    __metadata("design:type", Number)
], File.prototype, "expiresIn", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('timestamp') }),
    __metadata("design:type", Date)
], File.prototype, "expiresStartAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: 0 }),
    __metadata("design:type", Number)
], File.prototype, "currentAccessCount", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'varchar' }),
    __metadata("design:type", String)
], File.prototype, "password", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: false }),
    __metadata("design:type", Boolean)
], File.prototype, "isDeleted", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('timestamp') }),
    __metadata("design:type", Date)
], File.prototype, "deleteRequestedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('timestamp') }),
    __metadata("design:type", Date)
], File.prototype, "deleteScheduledAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('timestamp') }),
    __metadata("design:type", Date)
], File.prototype, "deleteCooldownUntil", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: false }),
    __metadata("design:type", Boolean)
], File.prototype, "deletedByAdmin", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => user_entity_1.User, (user) => user.files),
    (0, typeorm_1.JoinColumn)({ name: 'uploaderId' }),
    __metadata("design:type", user_entity_1.User)
], File.prototype, "uploader", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], File.prototype, "uploaderId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', default: 'ready' }),
    __metadata("design:type", String)
], File.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 1 }),
    __metadata("design:type", Number)
], File.prototype, "uploadVersion", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, default: 'committed' }),
    __metadata("design:type", String)
], File.prototype, "uploadStage", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 1000, nullable: true, select: false }),
    __metadata("design:type", String)
], File.prototype, "uploadFailureReason", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], File.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], File.prototype, "updatedAt", void 0);
exports.File = File = __decorate([
    (0, typeorm_1.Entity)('files'),
    (0, typeorm_1.Index)('idx_files_uploader_folder_deleted', ['uploaderId', 'folderId', 'isDeleted'])
], File);
