import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemConfig } from '../common/entities/system-config.entity';

/**
 * 全局配置模块 - 注册 SystemConfig 实体，使 TypeORM Repository 全局可用。
 * 此模块仅用于实体注册和导出，无独立的 service 层。
 * SystemConfig 的操作通过 ConfigCacheService 完成。
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([SystemConfig])],
  providers: [],
  exports: [TypeOrmModule],
})
export class AppConfigModule {}
