import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { File } from '../common/entities/file.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { TelegramService } from '../telegram/telegram.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([File, ShareAudit, FileAccessLog]),
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
  providers: [FileService, TelegramService],
  exports: [FileService],
})
export class FileModule {}
