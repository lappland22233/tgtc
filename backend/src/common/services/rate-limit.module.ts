import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RateLimitService } from './rate-limit.service';
import { RateLimit } from '../entities/rate-limit.entity';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([RateLimit])],
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class RateLimitModule {}
