import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { FileModule } from './file/file.module';
import { FolderModule } from './folder/folder.module';
import { ShareModule } from './share/share.module';
import { AdminModule } from './admin/admin.module';
import { AppConfigModule } from './config/config.module';
import { TasksModule } from './tasks/tasks.module';
import { ConfigCacheModule } from './common/services/config-cache.module';
import { RateLimitModule } from './common/services/rate-limit.module';
import { AuditModule } from './common/services/audit.module';
import { User } from './common/entities/user.entity';
import { File } from './common/entities/file.entity';
import { Folder } from './common/entities/folder.entity';
import { ShareLink } from './common/entities/share-link.entity';
import { SystemConfig } from './common/entities/system-config.entity';
import { VerificationCode } from './common/entities/verification-code.entity';
import { BannedIP } from './common/entities/banned-ip.entity';
import { ShareAudit } from './common/entities/share-audit.entity';
import { FileAccessLog } from './common/entities/file-access-log.entity';
import { RateLimit } from './common/entities/rate-limit.entity';
import { AuditLog } from './common/entities/audit-log.entity';
import { AccessLog } from './common/entities/access-log.entity';
import { Alert } from './common/entities/alert.entity';
import { DashboardConfig } from './common/entities/dashboard-config.entity';
import { UploadTask } from './common/entities/upload-task.entity';
import { Tag } from './common/entities/tag.entity';
import { TelemetryRecord } from './common/entities/telemetry-record.entity';
import { JwtRevokedToken } from './common/entities/jwt-revoked-token.entity';
import { SharePreviewSession } from './common/entities/share-preview-session.entity';
import { AccessLogModule } from './common/access-log.module';
import { JobsModule } from './jobs/jobs.module';
import { AlertModule } from './alert/alert.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { TelegramModule } from './telegram/telegram.module';
import { SecurityModule } from './security/security.module';
import { TagModule } from './tag/tag.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      username: process.env.DB_USERNAME || 'postgres',
      password: process.env.DB_PASSWORD || undefined,
      database: process.env.DB_DATABASE || 'test',
      entities: [User, File, Folder, ShareLink, SystemConfig, VerificationCode, BannedIP, ShareAudit, FileAccessLog, RateLimit, AuditLog, AccessLog, Alert, DashboardConfig, UploadTask, Tag, TelemetryRecord, JwtRevokedToken, SharePreviewSession],
      // 生产环境强制关闭 synchronize 防止误改 schema 丢数据；开发环境由 DB_SYNCHRONIZE 控制
      synchronize: process.env.NODE_ENV === 'production' ? false : process.env.DB_SYNCHRONIZE === 'true',
      migrations: [__dirname + '/migrations/*{.ts,.js}'],
      migrationsRun: process.env.DB_MIGRATIONS_RUN === 'true',
      logging: process.env.NODE_ENV === 'development',
      // 连接池：pg 默认仅 10 连接，高并发易耗尽；可通过 DB_POOL_SIZE 调整
      extra: {
        max: parseInt(process.env.DB_POOL_SIZE || '20', 10),
        connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '5000', 10),
        statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '30000', 10),
        query_timeout: parseInt(process.env.DB_QUERY_TIMEOUT_MS || '35000', 10),
        lock_timeout: parseInt(process.env.DB_LOCK_TIMEOUT_MS || '3000', 10),
        idle_in_transaction_session_timeout: parseInt(process.env.DB_IDLE_TRANSACTION_TIMEOUT_MS || '30000', 10),
        // 可选 TLS：DB_SSL=true 时启用（托管 PG 常见需求）
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
      },
    }),
    AuthModule,
    UserModule,
    FileModule,
    FolderModule,
    ShareModule,
    AdminModule,
    AppConfigModule,
    TasksModule,
    ConfigCacheModule,
    RateLimitModule,
    AuditModule,
    AccessLogModule,
    JobsModule,
    AlertModule,
    SecurityModule,
    TagModule,
    TelegramModule,
    TelemetryModule,
  ],
})
export class AppModule {}
