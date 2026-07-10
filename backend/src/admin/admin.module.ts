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
import { DashboardConfig } from '../common/entities/dashboard-config.entity';
import { Alert } from '../common/entities/alert.entity';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { ExportService } from './export.service';
import { FileModule } from '../file/file.module';
import { MailerModule } from '../mailer/mailer.module';
import { AlertModule } from '../alert/alert.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SystemConfig, BannedIP, File, User, FileAccessLog, AccessLog, AuditLog, DashboardConfig, Alert]),
    FileModule,
    MailerModule,
    forwardRef(() => AlertModule),
  ],
  controllers: [AdminController, DashboardController],
  providers: [AdminService, DashboardService, ExportService],
  exports: [AdminService],
})
export class AdminModule {}
