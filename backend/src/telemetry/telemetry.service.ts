import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelemetryRecord } from '../common/entities/telemetry-record.entity';

export interface TelemetryEvent {
  /** 事件类型：error/performance/environment 及前端扩展类型（network/click_context 等） */
  type: string;
  data: Record<string, any>;
  clientTimestamp?: number;
}

/** 单次上报硬上限（与 controller 的 @ArrayMaxSize 保持一致，作为服务层兜底） */
const MAX_EVENTS_PER_REPORT = 50;
/** 单个事件 data 载荷的最大字节数（服务层兜底，防止超大 JSON 入库） */
const MAX_DATA_BYTES = 8 * 1024;

/** type 列宽（varchar(32)），服务层兜底防止超长类型写入失败 */
const MAX_TYPE_LENGTH = 32;

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
   *
   * 安全兜底：即使上游校验被绕过，这里也强制限制事件数量（slice 硬上限）、
   * 校验类型形状、并对单条 data 载荷做大小检查（超限事件跳过），
   * 防止攻击者批量写入超大/超量数据撑爆数据库。
   * 注：不限制具体类型枚举——前端还会上报 network/click_context 等扩展类型，
   * 仅要求 type 为非空且不超过列宽的字符串，保持既有业务行为。
   */
  async report(events: TelemetryEvent[], ip: string, userAgent?: string, userId?: string): Promise<void> {
    if (!events || events.length === 0) return;

    // 硬上限：无论上游传入多少，最多只处理 MAX_EVENTS_PER_REPORT 条
    const bounded = events.slice(0, MAX_EVENTS_PER_REPORT);

    const records: TelemetryRecord[] = [];
    let skipped = 0;
    for (const e of bounded) {
      // 类型形状校验：非空字符串且不超过列宽（不限制枚举，兼容扩展类型）
      if (
        !e ||
        typeof e.type !== 'string' ||
        e.type.length === 0 ||
        e.type.length > MAX_TYPE_LENGTH
      ) {
        skipped++;
        continue;
      }

      const data = e.data ?? {};
      try {
        if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_DATA_BYTES) {
          // 载荷超限，跳过该事件
          skipped++;
          continue;
        }
      } catch {
        // 无法序列化（如循环引用），跳过
        skipped++;
        continue;
      }

      records.push(
        this.telemetryRepo.create({
          type: e.type,
          data,
          ip,
          userId: userId || null,
          userAgent: userAgent || null,
          clientTimestamp: e.clientTimestamp || null,
        }),
      );
    }

    if (records.length === 0) return;

    try {
      await this.telemetryRepo.save(records);
      // 不记录明文 IP（GDPR/个保法合规），仅记录数量与跳过数
      this.logger.log(
        `Saved ${records.length} telemetry records${skipped > 0 ? ` (skipped ${skipped} oversized/invalid)` : ''}`,
      );
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
