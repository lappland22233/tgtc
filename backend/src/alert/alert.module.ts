import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Alert } from '../common/entities/alert.entity';
import { AlertEngineService } from './alert-engine.service';
import { AlertService } from './alert.service';
import { AlertController } from './alert.controller';
import { AlertGateway } from './alert.gateway';
import { AuditModule } from '../common/services/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Alert]),
    AuditModule,
  ],
  controllers: [AlertController],
  providers: [AlertEngineService, AlertService, AlertGateway],
  exports: [AlertEngineService, AlertService, AlertGateway],
})
export class AlertModule {}
