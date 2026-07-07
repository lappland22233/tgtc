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
  // Singleflight: 相同 key 的并发回源共享同一个 Promise
  private pendingGets = new Map<string, Promise<string>>();
  private readonly CACHE_TTL: number;

  constructor(
    @InjectRepository(SystemConfig)
    private systemConfigRepository: Repository<SystemConfig>,
    private eventEmitter: EventEmitter2,
  ) {
    this.CACHE_TTL = Number(process.env.CACHE_TTL_MS ?? 30000);
    if (!Number.isFinite(this.CACHE_TTL) || this.CACHE_TTL < 1000) {
      this.CACHE_TTL = 30000;
    }
  }

  async get(key: string, defaultValue: string): Promise<string> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    // Singleflight: 防止缓存击穿，并发请求共享同一个 DB 查询
    const pending = this.pendingGets.get(key);
    if (pending) return pending;

    const promise = (async () => {
      const config = await this.systemConfigRepository.findOne({ where: { key } });
      const value = config?.value ?? defaultValue;
      this.cache.set(key, { value, expiresAt: Date.now() + this.CACHE_TTL });
      return value;
    })();

    this.pendingGets.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pendingGets.delete(key);
    }
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
    // 先收集匹配的键，再统一删除，避免迭代中修改 Map
    const keys = [...this.cache.keys()].filter((k) => k.startsWith(prefix));
    for (const key of keys) {
      this.cache.delete(key);
    }
  }
}
