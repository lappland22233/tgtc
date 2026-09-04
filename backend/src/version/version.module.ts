import { Module } from '@nestjs/common';
import { VersionService } from './version.service';

@Module({
  providers: [VersionService],
  exports: [VersionService],
})
export class VersionModule {}
