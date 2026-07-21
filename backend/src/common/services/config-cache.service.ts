import { Injectable, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(ConfigCacheService.name);
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
      if (config) {
        // 仅缓存数据库中真实存在的值；默认值不做负缓存，
        // 避免键新建后在 TTL 内对本实例不可见。
        this.cache.set(key, { value: config.value, expiresAt: Date.now() + this.CACHE_TTL });
        return config.value;
      }
      return defaultValue;
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
    // 配置已入库；订阅者抛错不应导致 set 返回 500，此处捕获并记录
    try {
      this.eventEmitter.emit('config.changed', { key, value });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`config.changed 订阅者处理失败 (key=${key}): ${message}`);
    }
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

    // 单次事件通知批量变更（订阅者抛错不影响已入库的写入）
    try {
      this.eventEmitter.emit('config.batch-changed', configs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`config.batch-changed 订阅者处理失败: ${message}`);
    }
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
