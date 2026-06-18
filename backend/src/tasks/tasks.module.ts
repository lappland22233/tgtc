import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TasksService } from './tasks.service';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { RateLimit } from '../common/entities/rate-limit.entity';
import { AccessLog } from '../common/entities/access-log.entity';
import { AuditLog } from '../common/entities/audit-log.entity';

@Module({
  imports: [TypeOrmModule.forFeature([BannedIP, ShareAudit, RateLimit, AccessLog, AuditLog])],
  providers: [TasksService],
})
export class TasksModule {}
