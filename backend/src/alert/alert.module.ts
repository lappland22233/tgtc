import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Alert } from '../common/entities/alert.entity';
import { User } from '../common/entities/user.entity';
import { AlertEngineService } from './alert-engine.service';
import { AlertService } from './alert.service';
import { AlertController } from './alert.controller';
import { AlertGateway } from './alert.gateway';
import { AuditModule } from '../common/services/audit.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Alert, User]),
    AuditModule,
    // AuthModule 导出 JwtModule，供 AlertGateway 验证连接 token
    AuthModule,
  ],
  controllers: [AlertController],
  providers: [AlertEngineService, AlertService, AlertGateway],
  exports: [AlertEngineService, AlertService, AlertGateway],
})
export class AlertModule {}
