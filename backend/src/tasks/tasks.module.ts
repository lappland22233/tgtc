import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TasksService } from './tasks.service';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { RateLimit } from '../common/entities/rate-limit.entity';

@Module({
  imports: [TypeOrmModule.forFeature([BannedIP, ShareAudit, RateLimit])],
  providers: [TasksService],
})
export class TasksModule {}
