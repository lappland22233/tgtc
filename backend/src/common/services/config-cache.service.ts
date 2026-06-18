import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SystemConfig } from '../entities/system-config.entity';

@Injectable()
export class ConfigCacheService {
  private cache = new Map<string, string>();

  constructor(
    @InjectRepository(SystemConfig)
    private systemConfigRepository: Repository<SystemConfig>,
    private eventEmitter: EventEmitter2,
  ) {}

  async get(key: string, defaultValue: string): Promise<string> {
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    const config = await this.systemConfigRepository.findOne({ where: { key } });
    const value = config?.value ?? defaultValue;
    this.cache.set(key, value);
    return value;
  }

  async set(key: string, value: string, description?: string): Promise<void> {
    // 使用 upsert 原子化操作，避免并发下的竞态条件
    await this.systemConfigRepository.upsert(
      { key, value, description: description ?? undefined, updatedAt: new Date() },
      ['key'],
    );

    this.cache.set(key, value);
    this.eventEmitter.emit('config.changed', { key, value });
  }

  async setBatch(
    configs: { key: string; value: string; description?: string }[],
  ): Promise<void> {
    if (configs.length === 0) return;

    // 批量 upsert：一次数据库操作完成所有写入
    const entities = configs.map((c) => ({
      key: c.key,
      value: c.value,
      description: c.description ?? undefined,
      updatedAt: new Date(),
    }));
    await this.systemConfigRepository.upsert(entities, ['key']);

    // 批量更新缓存
    for (const c of configs) {
      this.cache.set(c.key, c.value);
    }

    // 单次事件通知批量变更
    this.eventEmitter.emit('config.batch-changed', configs);
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  invalidateByPrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }
}
