import { User } from '../common/entities/user.entity';
import { File } from '../common/entities/file.entity';
import { Folder } from '../common/entities/folder.entity';
import { ShareLink } from '../common/entities/share-link.entity';
import { SystemConfig } from '../common/entities/system-config.entity';
import { VerificationCode } from '../common/entities/verification-code.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { RateLimit } from '../common/entities/rate-limit.entity';
import { AuditLog } from '../common/entities/audit-log.entity';
import { AccessLog } from '../common/entities/access-log.entity';
import { Alert } from '../common/entities/alert.entity';
import { UploadTask } from '../common/entities/upload-task.entity';
import { Tag } from '../common/entities/tag.entity';
import { JwtRevokedToken } from '../common/entities/jwt-revoked-token.entity';
import { SharePreviewSession } from '../common/entities/share-preview-session.entity';
import { FileVerifyTask } from '../common/entities/file-verify-task.entity';

/** 单一实体清单：Nest 运行时与 TypeORM CLI 必须共用，避免漏表。 */
export const databaseEntities = [
  User, File, Folder, ShareLink, SystemConfig, VerificationCode, BannedIP,
  ShareAudit, FileAccessLog, RateLimit, AuditLog, AccessLog, Alert, UploadTask,
  Tag, JwtRevokedToken, SharePreviewSession, FileVerifyTask,
] as const;
