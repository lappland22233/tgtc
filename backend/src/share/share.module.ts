import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ShareLink } from '../common/entities/share-link.entity';
import { File } from '../common/entities/file.entity';
import { Folder } from '../common/entities/folder.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareController } from './share.controller';
import { ShareService } from './share.service';
import { SharePasswordService } from './share-password.service';
import { SharePreviewSessionService } from './share-preview-session.service';
import { SharePreviewSession } from '../common/entities/share-preview-session.entity';
import { FileModule } from '../file/file.module';
import { ConfigCacheModule } from '../common/services/config-cache.module';
import { RateLimitModule } from '../common/services/rate-limit.module';

/**
 * 分享链接模块：Phase 2 核心实现。
 *
 * 注入实体：
 * - ShareLink: 主表
 * - File / Folder: 校验 target 存在性 + 子树查询
 * - BannedIP: IP 封禁表（与 file.service 共享同一张表）
 *
 * 依赖模块：
 * - FileModule: 复用 FileService.getStreamForShareDownload（流式下载）
 * - ConfigCacheModule / RateLimitModule: SharePasswordService 复用 IP 封禁逻辑
 * - JwtModule: 签发/校验 access JWT
 *
 * AuditModule 是全局模块，AuditService 通过全局 DI 注入，无需显式 import。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ShareLink, File, Folder, BannedIP, SharePreviewSession]),
    FileModule,
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
  controllers: [ShareController],
  providers: [ShareService, SharePasswordService, SharePreviewSessionService],
  exports: [ShareService, SharePasswordService],
})
export class ShareModule {}
