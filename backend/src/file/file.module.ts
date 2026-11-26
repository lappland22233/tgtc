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
import { UserPreferredDownloadService } from './user-preferred-download.service';
import { ThumbnailService } from './thumbnail.service';
import { UploadDiskBudgetService } from './upload-disk-budget.service';
import { StrictUploadModeGuard } from './strict-upload-mode.guard';
import { ConfigCacheModule } from '../common/services/config-cache.module';
import { RateLimitModule } from '../common/services/rate-limit.module';
import { MediaTicketModule } from '../common/services/media-ticket.module';
import { PublicMediaAdmissionService } from '../common/services/public-media-admission.service';
import { TagModule } from '../tag/tag.module';
import { ApiKeyModule } from '../api-key/api-key.module';
// 阶段 4：文件回源接入账号池 + 上传成功后触发镜像（均为可选增强，关闭时行为不变）
import { TelegramAccountPoolModule } from '../telegram-account-pool/telegram-account-pool.module';
import { TelegramMirrorModule } from '../telegram-mirror/telegram-mirror.module';
// 下载优先 user 账号时的 MTProto 客户端（叶子模块，无环）
import { TelegramUserModule } from '../telegram-user/telegram-user.module';
// 可插拔存储后端（S3 / WebDAV / GDrive 账号池）；未配置时行为与原 TG 链路一致
import { StorageModule } from '../storage/storage.module';

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
    // 账号池（副本表 + 账号感知回源）与镜像模块（触发入口）；未启用时不影响原链路
    TelegramAccountPoolModule,
    TelegramMirrorModule,
    // 用户账号目录（MTProto 账号来源）：下载优先 user 账号回源需要
    TelegramUserModule,
    StorageModule,
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
    // 临时能力：下载优先 Premium 用户账号（MTProto）回源；开关关闭时不介入。
    // 依赖（开关/预算/锚点/账号目录）在本模块导入图内闭合，见该服务类注释。
    UserPreferredDownloadService,
    // 下载任务：排队状态上报与取消（两阶段下载的第一阶段）
    DownloadTaskService,
    PublicMediaAdmissionService,
  ],
  // FileCacheService 供 Bot 直链匿名下载复用（同一实例，保证会话/缓存目录唯一）
  exports: [
    FileService,
    UploadDiskBudgetService,
    FileCacheService,
    DownloadResourceCoordinatorService,
    // Bot 直链下载入口在 TelegramBotModule，需要此处装配好的实例
    UserPreferredDownloadService,
  ],
})
export class FileModule {}
