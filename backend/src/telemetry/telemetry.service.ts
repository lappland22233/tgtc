import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelemetryRecord, TelemetryType } from '../common/entities/telemetry-record.entity';

export interface TelemetryEvent {
  type: TelemetryType;
  data: Record<string, any>;
  clientTimestamp?: number;
}

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(
    @InjectRepository(TelemetryRecord)
    private readonly telemetryRepo: Repository<TelemetryRecord>,
  ) {}

  /**
   * 批量保存遥测事件
   * 异步处理，不阻塞响应
   */
  async report(events: TelemetryEvent[], ip: string, userAgent?: string, userId?: string): Promise<void> {
    if (!events || events.length === 0) return;

    const records = events.map((e) =>
      this.telemetryRepo.create({
        type: e.type,
        data: e.data,
        ip,
        userId: userId || null,
        userAgent: userAgent || null,
        clientTimestamp: e.clientTimestamp || null,
      }),
    );

    try {
      await this.telemetryRepo.save(records);
      this.logger.log(`Saved ${records.length} telemetry records from ${ip}`);
    } catch (err) {
      // 遥测记录失败不影响主流程，静默记录日志
      this.logger.warn(`Failed to save telemetry records: ${(err as Error).message}`);
    }
  }

  /**
   * 按天清理过期遥测数据（保留 90 天）
   */
  async cleanupOld(days = 90): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await this.telemetryRepo
      .createQueryBuilder()
      .delete()
      .where('createdAt < :cutoff', { cutoff })
      .execute();
    return result.affected || 0;
  }
}
