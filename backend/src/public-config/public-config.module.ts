import { Module } from '@nestjs/common';
import { VersionModule } from '../version/version.module';
import { PublicConfigController } from './public-config.controller';
import { PublicConfigService } from './public-config.service';

@Module({
  imports: [VersionModule],
  controllers: [PublicConfigController],
  providers: [PublicConfigService],
})
export class PublicConfigModule {}
