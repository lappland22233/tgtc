import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SystemConfig } from '../common/entities/system-config.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { File } from '../common/entities/file.entity';
import { User } from '../common/entities/user.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { AccessLog } from '../common/entities/access-log.entity';
import { AuditLog } from '../common/entities/audit-log.entity';
import { FileModule } from '../file/file.module';
import { TelegramService } from '../telegram/telegram.service';
import { MailerService } from '../mailer/mailer.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([SystemConfig, BannedIP, File, User, FileAccessLog, AccessLog, AuditLog]),
    FileModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, TelegramService, MailerService],
  exports: [AdminService],
})
export class AdminModule {}
