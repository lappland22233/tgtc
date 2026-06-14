import { Global, Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccessLog } from './entities/access-log.entity';
import { AccessLogMiddleware } from './middleware/access-log.middleware';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AccessLog])],
  providers: [AccessLogMiddleware],
  exports: [TypeOrmModule.forFeature([AccessLog])],
})
export class AccessLogModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AccessLogMiddleware).forRoutes('*');
  }
}
