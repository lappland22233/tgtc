import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ConfigCacheService } from './config-cache.service';
import { SystemConfig } from '../entities/system-config.entity';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([SystemConfig]),
    EventEmitterModule.forRoot(),
  ],
  providers: [ConfigCacheService],
  exports: [ConfigCacheService],
})
export class ConfigCacheModule {}
