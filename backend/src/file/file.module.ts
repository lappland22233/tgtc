import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { File } from '../common/entities/file.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { UploadTask } from '../common/entities/upload-task.entity';
import { TelegramService } from '../telegram/telegram.service';
import { ThumbnailCryptoService } from './thumbnail-crypto.service';
import { UploadJobService } from './upload-job.service';
import { ConfigCacheModule } from '../common/services/config-cache.module';
import { RateLimitModule } from '../common/services/rate-limit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([File, FileAccessLog, BannedIP, ShareAudit, UploadTask]),
    ConfigCacheModule,
    RateLimitModule,
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
  controllers: [FileController],
  providers: [FileService, TelegramService, ThumbnailCryptoService, UploadJobService],
  exports: [FileService],
})
export class FileModule {}
