import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TelemetryRecord } from '../common/entities/telemetry-record.entity';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';

@Module({
  imports: [TypeOrmModule.forFeature([TelemetryRecord])],
  controllers: [TelemetryController],
  providers: [TelemetryService],
})
export class TelemetryModule {}
