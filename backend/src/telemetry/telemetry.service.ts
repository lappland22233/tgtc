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

/** G8-08：userAgent 列宽（varchar(500)），入库前截断防止整批失败 */
const MAX_USER_AGENT_LENGTH = 500;

/** G8-10：data 载荷内关键文本字段的长度上限（消息/堆栈/URL 等），写入前截断，
 *  既防超长字符串撑爆 jsonb/列宽，也压缩存储型 XSS 的面。 */
const MAX_TEXT_FIELD_LENGTH = 2000;
/** 截断时对这些文本键做长度限制。 */
const TEXT_LIMIT_KEYS = new Set(['message', 'stack', 'url', 'fileName']);

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

      // G8-10：先对关键文本字段（message/stack/url/fileName）做长度截断，
      // 再整体大小校验。防止超长/超限文本撑爆 jsonb 或放大存储型 XSS 面。
      const data = this.sanitizeData(e.data ?? {});
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
          // G8-08：入库前截断 UA 至列宽内，超长 UA 不再导致整批写入失败
          userAgent: userAgent ? userAgent.substring(0, MAX_USER_AGENT_LENGTH) : null,
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
   * G8-10：对 data 载荷内关键文本字段做长度截断（保守方案）。
   * 递归处理嵌套对象/数组，仅截断字符串值；非字符串值原样保留。
   * 管理端渲染时仍应把遥测内容视为不可信（防存储型 XSS 需在展示层转义）。
   */
  private sanitizeData(data: Record<string, any>): Record<string, any> {
    const sanitize = (value: unknown, key: string): unknown => {
      if (typeof value === 'string') {
        // 仅对已知高风险的自由文本键截断；其余字符串原样保留（避免破坏结构字段）
        return TEXT_LIMIT_KEYS.has(key) ? value.substring(0, MAX_TEXT_FIELD_LENGTH) : value;
      }
      if (Array.isArray(value)) {
        return value.map((v) => sanitize(v, key));
      }
      if (value && typeof value === 'object') {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, k);
        return out;
      }
      return value;
    };

    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) out[k] = sanitize(v, k);
    return out;
  }

  /**
   * 按天清理过期遥测数据（保留 90 天）
   * G8-09：分批删除（每批 1000 条），避免单条 DELETE 长事务阻塞数据库。
   */
  async cleanupOld(days = 90): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const BATCH_SIZE = 1000;
    let total = 0;
    // 循环删除，每批经子查询取 LIMIT 行 id，删净为止；单批失败抛出由调用方（Bull）重试
    for (;;) {
      const result = await this.telemetryRepo
        .createQueryBuilder()
        .delete()
        .where('createdAt < :cutoff', { cutoff })
        .andWhere(
          `id IN (SELECT id FROM telemetry_records WHERE "createdAt" < :cutoff LIMIT ${BATCH_SIZE})`,
        )
        .execute();
      const count = result.affected || 0;
      total += count;
      if (count < BATCH_SIZE) break;
    }
    return total;
  }
}
