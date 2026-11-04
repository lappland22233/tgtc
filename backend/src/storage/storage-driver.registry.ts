import { Injectable } from '@nestjs/common';
import type { RemoteStorageBackendType } from '../common/entities/storage-backend.entity';
import type { StorageBackendDriver } from './storage.types';

/**
 * 存储驱动注册表：打破「账号管理服务 ↔ 驱动 ↔ 路由器」的装配环。
 *
 * 驱动在 StorageModule.onModuleInit 阶段注册；账号管理（连通性测试）与
 * 路由器（上传/回源）都只依赖本注册表，不互相依赖。
 */
@Injectable()
export class StorageDriverRegistry {
  private readonly drivers = new Map<RemoteStorageBackendType, StorageBackendDriver>();

  register(driver: StorageBackendDriver): void {
    this.drivers.set(driver.type, driver);
  }

  get(type: RemoteStorageBackendType): StorageBackendDriver | null {
    return this.drivers.get(type) ?? null;
  }

  /** 已装配驱动的后端类型（管理端「默认后端」下拉只列出这些 + telegram） */
  types(): RemoteStorageBackendType[] {
    return Array.from(this.drivers.keys()).sort();
  }
}