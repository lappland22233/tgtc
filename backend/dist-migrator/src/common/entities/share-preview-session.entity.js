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
exports.SharePreviewSession = void 0;
const database_types_1 = require("../../database/database-types");
const typeorm_1 = require("typeorm");
/**
 * 服务端分享预览会话（C-03 修复核心）。
 *
 * 用途：把原本进程内 `previewSessions` Map（无访客隔离、非原子、非多实例一致）
 * 外置到 PostgreSQL，用「唯一约束 + 事务」实现首次返回文件字节前的原子扣次，
 * 同会话后续 Range / 连接重建 / 缓存冷热切换幂等免扣。
 *
 * 会话身份 = 分享链接 + 文件 + 高熵访客会话标识的不可逆摘要。
 * 键为 hash（sha256），绝不落库原始 Cookie / JWT 明文。
 *
 * 唯一约束 (shareLinkId, fileId, visitorHash) 保证：
 * - INSERT 成功 = 该访客对「该分享 + 该文件」的首次预览会话创建成功，此时才扣一次 maxAccessCount；
 * - INSERT 冲突 = 同一会话重试（同访客、同窗口内的 Range / 封面 / 重连），幂等免扣。
 */
let SharePreviewSession = class SharePreviewSession {
};
exports.SharePreviewSession = SharePreviewSession;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], SharePreviewSession.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('uuid') }),
    __metadata("design:type", String)
], SharePreviewSession.prototype, "shareLinkId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('uuid') }),
    __metadata("design:type", String)
], SharePreviewSession.prototype, "fileId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64 }),
    __metadata("design:type", String)
], SharePreviewSession.prototype, "visitorHash", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: true }),
    __metadata("design:type", Boolean)
], SharePreviewSession.prototype, "consumed", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], SharePreviewSession.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, database_types_1.databaseColumnType)('timestamp') }),
    __metadata("design:type", Date)
], SharePreviewSession.prototype, "expiresAt", void 0);
exports.SharePreviewSession = SharePreviewSession = __decorate([
    (0, typeorm_1.Entity)('share_preview_sessions'),
    (0, typeorm_1.Unique)('uq_share_preview_sessions_link_file_visitor', ['shareLinkId', 'fileId', 'visitorHash']),
    (0, typeorm_1.Index)('idx_share_preview_sessions_expires_at', ['expiresAt'])
], SharePreviewSession);
