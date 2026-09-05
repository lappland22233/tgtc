import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { createDatabaseOptions } from './database/database.config';
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
import { StreamResponderModule } from './common/services/stream-responder.module';
import { AccessLogModule } from './common/access-log.module';
import { JobsModule } from './jobs/jobs.module';
import { AlertModule } from './alert/alert.module';
import { TelegramModule } from './telegram/telegram.module';
import { SecurityModule } from './security/security.module';
import { TagModule } from './tag/tag.module';
import { PublicConfigModule } from './public-config/public-config.module';
import { HealthModule } from './health/health.module';
import { VersionModule } from './version/version.module';
import { UpdateModule } from './update/update.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot(createDatabaseOptions()),
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
    StreamResponderModule,
    AccessLogModule,
    JobsModule,
    AlertModule,
    SecurityModule,
    TagModule,
    PublicConfigModule,
    HealthModule,
    VersionModule,
    UpdateModule,
    TelegramModule,
  ],
})
export class AppModule {}
