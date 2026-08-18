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
  TelemetryCleanupProcessor,
  WeeklyReportProcessor,
} from './other.processors';
import { FileUploadProcessor } from './file-upload.processor';
import { FileVerifyProcessor } from './file-verify.processor';
import { AdminModule } from '../admin/admin.module';
import { SecurityModule } from '../security/security.module';
import { JobsSchedulerService } from './jobs-scheduler.service';
import { AccessLog } from '../common/entities/access-log.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { AuditLog } from '../common/entities/audit-log.entity';
import { Alert } from '../common/entities/alert.entity';
import { File } from '../common/entities/file.entity';
import { AlertModule } from '../alert/alert.module';
import { FileModule } from '../file/file.module';
import { TelemetryModule } from '../telemetry/telemetry.module';

@Module({
  imports: [
    BullQueueModule,
    TypeOrmModule.forFeature([AccessLog, BannedIP, AuditLog, Alert, File]),
    AlertModule,
    SecurityModule,
    FileModule,
    AdminModule,
    TelemetryModule,
  ],
  providers: [
    MetricsAggregationProcessor,
    AttackDetectionProcessor,
    AlertEvaluationProcessor,
    BaselineCalculationProcessor,
    DataArchivalProcessor,
    AnomalyDetectionProcessor,
    TelemetryCleanupProcessor,
    WeeklyReportProcessor,
    FileUploadProcessor,
    FileVerifyProcessor,
    JobsSchedulerService,
  ],
  exports: [JobsSchedulerService],
})
export class JobsModule {}
