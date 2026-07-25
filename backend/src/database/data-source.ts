import 'dotenv/config';
import { DataSource } from 'typeorm';
import { join } from 'path';
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
import { DashboardConfig } from '../common/entities/dashboard-config.entity';
import { UploadTask } from '../common/entities/upload-task.entity';
import { Tag } from '../common/entities/tag.entity';
import { TelemetryRecord } from '../common/entities/telemetry-record.entity';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  username: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || undefined,
  database: process.env.DB_DATABASE || 'test',
  entities: [User, File, Folder, ShareLink, SystemConfig, VerificationCode, BannedIP, ShareAudit, FileAccessLog, RateLimit, AuditLog, AccessLog, Alert, DashboardConfig, UploadTask, Tag, TelemetryRecord],
  // 相对本文件解析迁移目录，避免依赖运行时 CWD（编译产物 dist 下同样有效）
  migrations: [join(__dirname, '..', 'migrations', '*{.ts,.js}')],
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
  maxQueryExecutionTime: 5000, // D-4: 慢查询检测阈值（毫秒）
  // 连接池大小，与应用配置保持一致
  extra: {
    max: parseInt(process.env.DB_POOL_SIZE || '20', 10),
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  },
});
