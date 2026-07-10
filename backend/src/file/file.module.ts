import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { BullModule } from '@nestjs/bull';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QUEUE_NAMES } from '../jobs/bull-queue.module';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { File } from '../common/entities/file.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { UploadTask } from '../common/entities/upload-task.entity';
import { TelegramModule } from '../telegram/telegram.module';
import { ThumbnailCryptoService } from './thumbnail-crypto.service';
import { UploadJobService } from './upload-job.service';
import { ChunkUploadService } from './chunk-upload.service';
import { ChunkUploadController } from './chunk-upload.controller';
import { FileCacheService } from './file-cache.service';
import { ConfigCacheModule } from '../common/services/config-cache.module';
import { RateLimitModule } from '../common/services/rate-limit.module';
import { TagModule } from '../tag/tag.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([File, FileAccessLog, BannedIP, ShareAudit, UploadTask]),
    ConfigCacheModule,
    RateLimitModule,
    TagModule,
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
  controllers: [FileController, ChunkUploadController],
  providers: [FileService, ThumbnailCryptoService, UploadJobService, ChunkUploadService, FileCacheService],
  exports: [FileService],
})
export class FileModule {}
