import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, IsNull } from 'typeorm';
import { Alert, AlertLevel } from '../common/entities/alert.entity';
import { ALERT_RULES } from './alert.rules';

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
    await this.alertRepo.update(alertId, {
      acknowledgedAt: new Date(),
      acknowledgedBy: userId,
    });
    this.logger.log(`告警 ${alertId} 已确认 (用户: ${userId})`);
  }

  /** 一键确认全部未确认告警 */
  async acknowledgeAll(userId: string): Promise<number> {
    const result = await this.alertRepo.update(
      { acknowledgedAt: IsNull() },
      { acknowledgedAt: new Date(), acknowledgedBy: userId },
    );
    this.logger.log(`确认了 ${result.affected || 0} 条告警 (用户: ${userId})`);
    return result.affected || 0;
  }

  /** 获取告警规则列表 */
  getRules() {
    return ALERT_RULES.map((r) => ({
      id: r.id,
      name: r.name,
      level: r.level,
      cooldownMinutes: r.cooldownMinutes,
    }));
  }
}
