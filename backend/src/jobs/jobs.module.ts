import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullQueueModule } from './bull-queue.module';
import { MetricsAggregationProcessor } from './metrics-aggregation.processor';
import { AttackDetectionProcessor } from './attack-detection.processor';
import {
  AlertEvaluationProcessor,
  BaselineCalculationProcessor,
  DataArchivalProcessor,
  AnomalyDetectionProcessor,
  WeeklyReportProcessor,
} from './other.processors';
import { SecurityModule } from '../security/security.module';
import { JobsSchedulerService } from './jobs-scheduler.service';
import { AccessLog } from '../common/entities/access-log.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { AuditLog } from '../common/entities/audit-log.entity';
import { Alert } from '../common/entities/alert.entity';
import { AlertModule } from '../alert/alert.module';

@Module({
  imports: [
    BullQueueModule,
    TypeOrmModule.forFeature([AccessLog, BannedIP, AuditLog, Alert]),
    AlertModule,
    SecurityModule,
  ],
  providers: [
    MetricsAggregationProcessor,
    AttackDetectionProcessor,
    AlertEvaluationProcessor,
    BaselineCalculationProcessor,
    DataArchivalProcessor,
    AnomalyDetectionProcessor,
    WeeklyReportProcessor,
    JobsSchedulerService,
  ],
  exports: [JobsSchedulerService],
})
export class JobsModule {}
