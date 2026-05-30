import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BannedIP } from '../common/entities/banned-ip.entity';

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    @InjectRepository(BannedIP)
    private bannedIPRepository: Repository<BannedIP>,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredBans() {
    try {
      const result = await this.bannedIPRepository.delete({
        isPermanent: false,
        expiresAt: LessThan(new Date()),
      });
      if ((result.affected ?? 0) > 0) {
        this.logger.log(`已清理 ${result.affected} 条过期封禁记录`);
      }
    } catch (error: unknown) {
      this.logger.error('清理过期封禁记录失败', error instanceof Error ? error.message : String(error));
    }
  }
}
