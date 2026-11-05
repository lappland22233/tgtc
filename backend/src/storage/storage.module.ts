import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageBackend } from '../common/entities/storage-backend.entity';
import { AuditModule } from '../common/services/audit.module';
import { ConfigCacheModule } from '../common/services/config-cache.module';
// 告警引擎：存储池容量耗尽告警复用全站告警体系（与 BOT_POOL_* 同一模式）
import { AlertModule } from '../alert/alert.module';
import { GDriveOAuthService } from './gdrive-oauth.service';
import { S3StorageDriver } from './drivers/s3.driver';
import { WebDavStorageDriver } from './drivers/webdav.driver';
import { GDriveStorageDriver } from './drivers/gdrive.driver';
import { StorageAccountSchedulerService } from './storage-account-scheduler.service';
import { StorageBackendsController } from './storage-backends.controller';
import { StorageBackendsService } from './storage-backends.service';
import { StorageCredentialService } from './storage-credential.service';
import { StorageDriverRegistry } from './storage-driver.registry';
import { StorageRouterService } from './storage-router.service';

/**
 * 可插拔存储模块：S3 / WebDAV / Google Drive 账号池。
 *
 * Telegram 不在本模块装配——TG 链路（账号池/镜像/副本）原样保留，
 * 由 FileService 按 `file.storageBackend` 分发，保证 TG 行为逐字节不变。
 *
 * 驱动在 onModuleInit 注册进 StorageDriverRegistry（打破账号管理 ↔ 驱动的装配环）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([StorageBackend]),
    ConfigCacheModule,
    AuditModule,
    AlertModule,
  ],
  controllers: [StorageBackendsController],
  providers: [
    StorageCredentialService,
    StorageAccountSchedulerService,
    StorageDriverRegistry,
    StorageBackendsService,
    StorageRouterService,
    GDriveOAuthService,
    S3StorageDriver,
    WebDavStorageDriver,
    GDriveStorageDriver,
  ],
  exports: [StorageRouterService, StorageBackendsService, StorageAccountSchedulerService],
})
export class StorageModule implements OnModuleInit {
  constructor(
    private readonly registry: StorageDriverRegistry,
    private readonly s3: S3StorageDriver,
    private readonly webdav: WebDavStorageDriver,
    private readonly gdrive: GDriveStorageDriver,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.s3);
    this.registry.register(this.webdav);
    this.registry.register(this.gdrive);
  }
}