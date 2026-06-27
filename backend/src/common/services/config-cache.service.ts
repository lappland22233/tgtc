import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SystemConfig } from '../entities/system-config.entity';

interface CacheEntry {
  value: string;
  expiresAt: number;
}

@Injectable()
export class ConfigCacheService {
  // 进程内缓存。多实例部署时缓存不共享，TTL 限制保证最终一致性（最多滞后 TTL 毫秒）
  private cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL = 30_000; // 30 秒

  constructor(
    @InjectRepository(SystemConfig)
    private systemConfigRepository: Repository<SystemConfig>,
    private eventEmitter: EventEmitter2,
  ) {}

  async get(key: string, defaultValue: string): Promise<string> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const config = await this.systemConfigRepository.findOne({ where: { key } });
    const value = config?.value ?? defaultValue;
    this.cache.set(key, { value, expiresAt: Date.now() + this.CACHE_TTL });
    return value;
  }

  async set(key: string, value: string, description?: string): Promise<void> {
    // 使用 upsert 原子化操作，避免并发下的竞态条件
    await this.systemConfigRepository.upsert(
      { key, value, description: description ?? undefined, updatedAt: new Date() },
      ['key'],
    );

    this.cache.set(key, { value, expiresAt: Date.now() + this.CACHE_TTL });
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
    const expiresAt = Date.now() + this.CACHE_TTL;
    for (const c of configs) {
      this.cache.set(c.key, { value: c.value, expiresAt });
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
