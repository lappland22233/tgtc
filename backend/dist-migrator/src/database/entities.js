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
const update_task_entity_1 = require("../common/entities/update-task.entity");
const api_key_entity_1 = require("../common/entities/api-key.entity");
const directory_name_entity_1 = require("../common/entities/directory-name.entity");
const api_key_ip_allowlist_entity_1 = require("../common/entities/api-key-ip-allowlist.entity");
const api_key_usage_log_entity_1 = require("../common/entities/api-key-usage-log.entity");
const telegram_bot_file_grant_entity_1 = require("../common/entities/telegram-bot-file-grant.entity");
const telegram_bot_daily_usage_entity_1 = require("../common/entities/telegram-bot-daily-usage.entity");
const telegram_bot_whitelist_entity_1 = require("../common/entities/telegram-bot-whitelist.entity");
const download_task_entity_1 = require("../common/entities/download-task.entity");
const telegram_file_copy_entity_1 = require("../common/entities/telegram-file-copy.entity");
const telegram_account_entity_1 = require("../common/entities/telegram-account.entity");
const telegram_mirror_rule_entity_1 = require("../common/entities/telegram-mirror-rule.entity");
const telegram_mirror_task_entity_1 = require("../common/entities/telegram-mirror-task.entity");
const telegram_replication_attempt_entity_1 = require("../common/entities/telegram-replication-attempt.entity");
const telegram_main_chat_anchor_entity_1 = require("../common/entities/telegram-main-chat-anchor.entity");
const gdrive_oauth_flow_entity_1 = require("../common/entities/gdrive-oauth-flow.entity");
const storage_backend_entity_1 = require("../common/entities/storage-backend.entity");
/** 单一实体清单：Nest 运行时与 TypeORM CLI 必须共用，避免漏表。 */
exports.databaseEntities = [
    user_entity_1.User, file_entity_1.File, folder_entity_1.Folder, share_link_entity_1.ShareLink, system_config_entity_1.SystemConfig, verification_code_entity_1.VerificationCode, banned_ip_entity_1.BannedIP,
    share_audit_entity_1.ShareAudit, file_access_log_entity_1.FileAccessLog, rate_limit_entity_1.RateLimit, audit_log_entity_1.AuditLog, access_log_entity_1.AccessLog, alert_entity_1.Alert, upload_task_entity_1.UploadTask,
    tag_entity_1.Tag, jwt_revoked_token_entity_1.JwtRevokedToken, share_preview_session_entity_1.SharePreviewSession, file_verify_task_entity_1.FileVerifyTask, update_task_entity_1.UpdateTask, api_key_entity_1.ApiKey,
    directory_name_entity_1.DirectoryName, api_key_ip_allowlist_entity_1.ApiKeyIpAllowlist, api_key_usage_log_entity_1.ApiKeyUsageLog,
    telegram_bot_file_grant_entity_1.TelegramBotFileGrant, telegram_bot_daily_usage_entity_1.TelegramBotDailyUsage, telegram_bot_whitelist_entity_1.TelegramBotWhitelist,
    download_task_entity_1.DownloadTask, telegram_file_copy_entity_1.TelegramFileCopy, telegram_account_entity_1.TelegramAccount, telegram_mirror_rule_entity_1.TelegramMirrorRule, telegram_mirror_task_entity_1.TelegramMirrorTask,
    telegram_replication_attempt_entity_1.TelegramReplicationAttempt, telegram_main_chat_anchor_entity_1.TelegramMainChatAnchor, storage_backend_entity_1.StorageBackend, gdrive_oauth_flow_entity_1.GDriveOAuthFlow,
];
