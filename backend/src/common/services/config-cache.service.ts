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
    const existing = await this.systemConfigRepository.findOne({ where: { key } });

    if (existing) {
      await this.systemConfigRepository.update(existing.id, { value, description });
    } else {
      const config = this.systemConfigRepository.create({ key, value, description });
      await this.systemConfigRepository.save(config);
    }

    this.cache.set(key, value);
    this.eventEmitter.emit('config.changed', { key, value });
  }

  async setBatch(
    configs: { key: string; value: string; description?: string }[],
  ): Promise<void> {
    for (const config of configs) {
      await this.set(config.key, config.value, config.description);
    }
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
