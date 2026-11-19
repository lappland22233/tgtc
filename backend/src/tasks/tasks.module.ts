import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { TasksService } from './tasks.service';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { RateLimit } from '../common/entities/rate-limit.entity';
import { AccessLog } from '../common/entities/access-log.entity';
import { AuditLog } from '../common/entities/audit-log.entity';
import { JwtRevokedToken } from '../common/entities/jwt-revoked-token.entity';
import { File } from '../common/entities/file.entity';
import { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';
import { StorageModule } from '../storage/storage.module';
import { TelegramBotModule } from '../telegram-bot/telegram-bot.module';
import { QUEUE_NAMES } from '../jobs/bull-queue.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([BannedIP, ShareAudit, RateLimit, AccessLog, AuditLog, JwtRevokedToken, File, TelegramBotFileGrant]),
    BullModule.registerQueue({ name: QUEUE_NAMES.FILE_UPLOAD }),
    StorageModule,
    TelegramBotModule,
  ],
  providers: [TasksService],
  // TasksService 仅为内部 @Cron 定时调度使用，无需 exports
})
export class TasksModule {}
