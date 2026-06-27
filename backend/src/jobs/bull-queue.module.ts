import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';

export const QUEUE_NAMES = {
  METRICS_AGGREGATION: 'metrics-aggregation',
  ATTACK_DETECTION: 'attack-detection',
  ALERT_EVALUATION: 'alert-evaluation',
  BASELINE_CALCULATION: 'baseline-calculation',
  DATA_ARCHIVAL: 'data-archival',
} as const;

@Module({
  imports: [
    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
        db: parseInt(process.env.REDIS_DB || '0', 10),
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => Math.min(times * 200, 2000),
      },
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.METRICS_AGGREGATION },
      { name: QUEUE_NAMES.ATTACK_DETECTION },
      { name: QUEUE_NAMES.ALERT_EVALUATION },
      { name: QUEUE_NAMES.BASELINE_CALCULATION },
      { name: QUEUE_NAMES.DATA_ARCHIVAL },
    ),
  ],
  exports: [BullModule],
})
export class BullQueueModule {}
