import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemConfig } from '../common/entities/system-config.entity';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([SystemConfig])],
  providers: [],
  exports: [TypeOrmModule],
})
export class AppConfigModule {}
