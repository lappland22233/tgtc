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
exports.ShareLink = exports.ShareLinkStatus = exports.ShareTargetType = void 0;
const typeorm_1 = require("typeorm");
const user_entity_1 = require("./user.entity");
const database_types_1 = require("../../database/database-types");
/**
 * 分享目标类型：
 * - FILE: 分享单个文件
 * - FOLDER: 分享整个文件夹（含子层级）
 */
var ShareTargetType;
(function (ShareTargetType) {
    ShareTargetType["FILE"] = "file";
    ShareTargetType["FOLDER"] = "folder";
})(ShareTargetType || (exports.ShareTargetType = ShareTargetType = {}));
/**
 * 分享链接状态：
 * - ACTIVE: 正常可用
 * - DISABLED: 创建者主动取消
 * - EXPIRED: 已超过有效期
 * - EXHAUSTED: 访问次数已耗尽
 *
 * 状态由 Service 在每次访问时计算并更新，不依赖定时任务。
 */
var ShareLinkStatus;
(function (ShareLinkStatus) {
    ShareLinkStatus["ACTIVE"] = "active";
    ShareLinkStatus["DISABLED"] = "disabled";
    ShareLinkStatus["EXPIRED"] = "expired";
    ShareLinkStatus["EXHAUSTED"] = "exhausted";
})(ShareLinkStatus || (exports.ShareLinkStatus = ShareLinkStatus = {}));
/**
 * 分享链接实体（独立分享模型）。
 *
 * 设计要点：
 * 1. 同一个文件/文件夹可以有多条 ShareLink（不同密码、不同有效期）。
 * 2. token 是 URL 段，用 crypto.randomBytes(9).toString('base64url')，12 字符熵 ~72 bit。
 * 3. password 字段存 bcrypt hash，null 表示公开分享。
 * 4. expiresIn 是小时数，expiresStartAt 是首次访问时间（首次访问触发计时）。
 * 5. maxAccessCount = -1 表示不限。
 *
 * 严格模式密码保护关键设计：
 * getSharePublicInfo 在 link.password != null && !accessJwt 时直接返回
 *   { requiresPassword: true }，**不查询 target 表**，杜绝元数据泄露。
 */
let ShareLink = class ShareLink {
};
exports.ShareLink = ShareLink;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], ShareLink.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Index)({ unique: true }),
    (0, typeorm_1.Column)({ type: 'varchar', length: 64 }),
    __metadata("design:type", String)
], ShareLink.prototype, "token", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('enum'), enum: ShareTargetType }),
    __metadata("design:type", String)
], ShareLink.prototype, "targetType", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)({ type: 'uuid' }),
    __metadata("design:type", String)
], ShareLink.prototype, "targetId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'uuid' }),
    __metadata("design:type", String)
], ShareLink.prototype, "creatorId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => user_entity_1.User),
    (0, typeorm_1.JoinColumn)({ name: 'creatorId' }),
    __metadata("design:type", user_entity_1.User)
], ShareLink.prototype, "creator", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'varchar' }),
    __metadata("design:type", String)
], ShareLink.prototype, "password", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: -1 }),
    __metadata("design:type", Number)
], ShareLink.prototype, "maxAccessCount", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: 0 }),
    __metadata("design:type", Number)
], ShareLink.prototype, "currentAccessCount", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: 'int' }),
    __metadata("design:type", Number)
], ShareLink.prototype, "expiresIn", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, type: (0, database_types_1.databaseColumnType)('timestamp') }),
    __metadata("design:type", Date)
], ShareLink.prototype, "expiresStartAt", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: (0, database_types_1.databaseColumnType)('enum'),
        enum: ShareLinkStatus,
        default: ShareLinkStatus.ACTIVE,
    }),
    __metadata("design:type", String)
], ShareLink.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: false }),
    __metadata("design:type", Boolean)
], ShareLink.prototype, "isDeleted", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], ShareLink.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], ShareLink.prototype, "updatedAt", void 0);
exports.ShareLink = ShareLink = __decorate([
    (0, typeorm_1.Entity)('share_links'),
    (0, typeorm_1.Index)('idx_share_links_creatorId', ['creatorId'])
], ShareLink);
