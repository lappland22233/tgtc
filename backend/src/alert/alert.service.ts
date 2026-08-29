import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, IsNull } from 'typeorm';
import { Alert, AlertLevel } from '../common/entities/alert.entity';
import { getAlertRuleMetadata } from './alert.rules';
import { databaseCurrentTimestamp, databaseQuery, getDatabaseType } from '../database/database-types';

@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);

  constructor(
    @InjectRepository(Alert)
    private alertRepo: Repository<Alert>,
  ) {}

  /** 分页获取告警列表 */
  async getAlerts(query: {
    page?: number;
    limit?: number;
    level?: AlertLevel;
    acknowledged?: boolean;
  }): Promise<{ items: Alert[]; total: number }> {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));

    const where: any = {};
    if (query.level) where.level = query.level;
    if (query.acknowledged === true) {
      where.acknowledgedAt = MoreThan(new Date(0));
    } else if (query.acknowledged === false) {
      where.acknowledgedAt = IsNull();
    }

    const [items, total] = await this.alertRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { items, total };
  }

  /** 获取未确认告警 */
  async getUnacknowledged(): Promise<Alert[]> {
    return this.alertRepo.find({
      where: { acknowledgedAt: IsNull() },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  /** 确认单条告警 */
  async acknowledge(alertId: string, userId: string): Promise<void> {
    const result = await this.alertRepo.update(alertId, {
      acknowledgedAt: new Date(),
      acknowledgedBy: userId,
    });
    // 无效 id 不再静默返回成功
    if ((result.affected ?? 0) === 0) {
      throw new NotFoundException('告警不存在');
    }
    this.logger.log(`告警 ${alertId} 已确认 (用户: ${userId})`);
  }

  /** 一键确认全部未确认告警（分批更新，避免长事务锁表） */
  async acknowledgeAll(userId: string): Promise<number> {
    const BATCH_SIZE = 1000;
    const MAX_BATCHES = 100;
    let total = 0;
    let batches = 0;

    // 分批 UPDATE（每批 1000 条），避免无条件全表 UPDATE 造成长事务锁表
    while (batches < MAX_BATCHES) {
      const rows = await databaseQuery(
        this.alertRepo.manager,
        `UPDATE alerts SET "acknowledgedAt" = ${databaseCurrentTimestamp()}, "acknowledgedBy" = $1
         WHERE id IN (
           SELECT id FROM alerts WHERE "acknowledgedAt" IS NULL LIMIT ${BATCH_SIZE}
         )
         RETURNING id`,
        [userId],
        getDatabaseType(),
      );
      const affected = Array.isArray(rows) ? rows.length : 0;
      total += affected;
      batches++;
      if (affected < BATCH_SIZE) break;
    }

    this.logger.log(`确认了 ${total} 条告警 (用户: ${userId})`);
    return total;
  }

  /** 获取告警规则列表 */
  getRules() {
    return getAlertRuleMetadata();
  }
}
