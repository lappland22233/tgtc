"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.databaseEntities = void 0;
const user_entity_1 = require("../common/entities/user.entity");
const file_entity_1 = require("../common/entities/file.entity");
const folder_entity_1 = require("../common/entities/folder.entity");
const share_link_entity_1 = require("../common/entities/share-link.entity");
const system_config_entity_1 = require("../common/entities/system-config.entity");
const verification_code_entity_1 = require("../common/entities/verification-code.entity");
const banned_ip_entity_1 = require("../common/entities/banned-ip.entity");
const share_audit_entity_1 = require("../common/entities/share-audit.entity");
const file_access_log_entity_1 = require("../common/entities/file-access-log.entity");
const rate_limit_entity_1 = require("../common/entities/rate-limit.entity");
const audit_log_entity_1 = require("../common/entities/audit-log.entity");
const access_log_entity_1 = require("../common/entities/access-log.entity");
const alert_entity_1 = require("../common/entities/alert.entity");
const upload_task_entity_1 = require("../common/entities/upload-task.entity");
const tag_entity_1 = require("../common/entities/tag.entity");
const jwt_revoked_token_entity_1 = require("../common/entities/jwt-revoked-token.entity");
const share_preview_session_entity_1 = require("../common/entities/share-preview-session.entity");
const file_verify_task_entity_1 = require("../common/entities/file-verify-task.entity");
/** 单一实体清单：Nest 运行时与 TypeORM CLI 必须共用，避免漏表。 */
exports.databaseEntities = [
    user_entity_1.User, file_entity_1.File, folder_entity_1.Folder, share_link_entity_1.ShareLink, system_config_entity_1.SystemConfig, verification_code_entity_1.VerificationCode, banned_ip_entity_1.BannedIP,
    share_audit_entity_1.ShareAudit, file_access_log_entity_1.FileAccessLog, rate_limit_entity_1.RateLimit, audit_log_entity_1.AuditLog, access_log_entity_1.AccessLog, alert_entity_1.Alert, upload_task_entity_1.UploadTask,
    tag_entity_1.Tag, jwt_revoked_token_entity_1.JwtRevokedToken, share_preview_session_entity_1.SharePreviewSession, file_verify_task_entity_1.FileVerifyTask,
];
