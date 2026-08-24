import { Module, forwardRef } from '@nestjs/common';
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
import { Alert } from '../common/entities/alert.entity';
import { ExportService } from './export.service';
import { FileVerifyService } from './file-verify.service';
import { FileVerifyTask } from '../common/entities/file-verify-task.entity';
import { BullQueueModule } from '../jobs/bull-queue.module';
import { FileModule } from '../file/file.module';
import { MailerModule } from '../mailer/mailer.module';
import { AlertModule } from '../alert/alert.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SystemConfig, BannedIP, File, User, FileAccessLog, AccessLog, AuditLog, Alert, FileVerifyTask]),
    BullQueueModule,
    FileModule,
    MailerModule,
    forwardRef(() => AlertModule),
  ],
  controllers: [AdminController],
  providers: [AdminService, ExportService, FileVerifyService],
  exports: [AdminService, FileVerifyService],
})
export class AdminModule {}
