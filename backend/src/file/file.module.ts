import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { BullModule } from '@nestjs/bull';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QUEUE_NAMES } from '../jobs/bull-queue.module';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { FileAccessControlService } from './file-access-control.service';
import { FileUploadConfigService } from './file-upload-config.service';
import { File } from '../common/entities/file.entity';
import { Folder } from '../common/entities/folder.entity';
import { DownloadTask } from '../common/entities/download-task.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { ShareLink } from '../common/entities/share-link.entity';
import { UploadTask } from '../common/entities/upload-task.entity';
import { TelegramModule } from '../telegram/telegram.module';
import { FolderModule } from '../folder/folder.module';
import { ThumbnailCryptoService } from './thumbnail-crypto.service';
import { UploadJobService } from './upload-job.service';
import { ChunkUploadService } from './chunk-upload.service';
import { ChunkUploadController } from './chunk-upload.controller';
import { DownloadTaskController } from './download-task.controller';
import { DownloadTaskService } from './download-task.service';
import { ChunkUploadResourceInterceptor } from './chunk-upload-resource.interceptor';
import { FileCacheService } from './file-cache.service';
import { DownloadResourceCoordinatorService } from './download-resource-coordinator.service';
import { ThumbnailService } from './thumbnail.service';
import { UploadDiskBudgetService } from './upload-disk-budget.service';
import { StrictUploadModeGuard } from './strict-upload-mode.guard';
import { ConfigCacheModule } from '../common/services/config-cache.module';
import { RateLimitModule } from '../common/services/rate-limit.module';
import { MediaTicketModule } from '../common/services/media-ticket.module';
import { TagModule } from '../tag/tag.module';
import { ApiKeyModule } from '../api-key/api-key.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([File, Folder, FileAccessLog, BannedIP, ShareAudit, ShareLink, UploadTask, DownloadTask]),
    ConfigCacheModule,
    RateLimitModule,
    TagModule,
    ApiKeyModule,
    MediaTicketModule,
    FolderModule,
    TelegramModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.FILE_UPLOAD }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: (() => {
          const secret = configService.get<string>('JWT_SECRET');
          if (!secret) {
            throw new Error('JWT_SECRET 环境变量未配置，请设置后再启动服务');
          }
          return secret;
        })(),
      }),
    }),
  ],
  controllers: [FileController, ChunkUploadController, DownloadTaskController],
  providers: [
    FileService,
    // M6 拆分：访问策略 / 密码 / IP 封禁域
    FileAccessControlService,
    // M6 拆分：上传配置与类型/大小校验域
    FileUploadConfigService,
    ThumbnailCryptoService,
    UploadJobService,
    UploadDiskBudgetService,
    ChunkUploadService,
    ChunkUploadResourceInterceptor,
    StrictUploadModeGuard,
    FileCacheService,
    ThumbnailService,
    // 下载资源协调器：磁盘/缓存逻辑容量预约与上游 FIFO 租约的唯一单例
    DownloadResourceCoordinatorService,
    // 下载任务：排队状态上报与取消（两阶段下载的第一阶段）
    DownloadTaskService,
  ],
  // FileCacheService 供 Bot 直链匿名下载复用（同一实例，保证会话/缓存目录唯一）
  exports: [FileService, UploadDiskBudgetService, FileCacheService, DownloadResourceCoordinatorService],
})
export class FileModule {}
