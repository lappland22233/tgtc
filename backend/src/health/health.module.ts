import { Module } from '@nestjs/common';
import { VersionModule } from '../version/version.module';
import { BullQueueModule } from '../jobs/bull-queue.module';
import { HealthController } from './health.controller';

@Module({
  imports: [VersionModule, BullQueueModule],
  controllers: [HealthController],
})
export class HealthModule {}
