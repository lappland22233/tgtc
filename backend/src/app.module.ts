import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { FileModule } from './file/file.module';
import { AdminModule } from './admin/admin.module';
import { AppConfigModule } from './config/config.module';
import { TasksModule } from './tasks/tasks.module';
import { ConfigCacheModule } from './common/services/config-cache.module';
import { RateLimitModule } from './common/services/rate-limit.module';
import { AuditModule } from './common/services/audit.module';
import { User } from './common/entities/user.entity';
import { File } from './common/entities/file.entity';
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
import { AccessLogModule } from './common/access-log.module';
import { JobsModule } from './jobs/jobs.module';
import { AlertModule } from './alert/alert.module';
import { SecurityModule } from './security/security.module';

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
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_DATABASE || 'file_distribution',
      entities: [User, File, SystemConfig, VerificationCode, BannedIP, ShareAudit, FileAccessLog, RateLimit, AuditLog, AccessLog, Alert, DashboardConfig],
      // 生产环境强制关闭 synchronize 防止误改 schema 丢数据；开发环境由 DB_SYNCHRONIZE 控制
      synchronize: process.env.NODE_ENV === 'production' ? false : process.env.DB_SYNCHRONIZE === 'true',
      migrations: [__dirname + '/migrations/*{.ts,.js}'],
      migrationsRun: process.env.DB_MIGRATIONS_RUN === 'true',
      logging: process.env.NODE_ENV === 'development',
    }),
    AuthModule,
    UserModule,
    FileModule,
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
  ],
})
export class AppModule {}
