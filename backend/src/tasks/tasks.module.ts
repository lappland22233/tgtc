import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TasksService } from './tasks.service';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { RateLimit } from '../common/entities/rate-limit.entity';
import { AccessLog } from '../common/entities/access-log.entity';
import { AuditLog } from '../common/entities/audit-log.entity';
import { JwtRevokedToken } from '../common/entities/jwt-revoked-token.entity';
import { File } from '../common/entities/file.entity';

@Module({
  imports: [TypeOrmModule.forFeature([BannedIP, ShareAudit, RateLimit, AccessLog, AuditLog, JwtRevokedToken, File])],
  providers: [TasksService],
  // TasksService 仅为内部 @Cron 定时调度使用，无需 exports
})
export class TasksModule {}
