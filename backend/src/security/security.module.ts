import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BehaviorAnalyzer } from './behavior-analyzer.service';
import { Alert } from '../common/entities/alert.entity';
import { AlertModule } from '../alert/alert.module';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Alert]), AlertModule],
  providers: [BehaviorAnalyzer],
  exports: [BehaviorAnalyzer],
})
export class SecurityModule {}
