import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';

export const QUEUE_NAMES = {
  METRICS_AGGREGATION: 'metrics-aggregation',
  ATTACK_DETECTION: 'attack-detection',
  ALERT_EVALUATION: 'alert-evaluation',
  BASELINE_CALCULATION: 'baseline-calculation',
  DATA_ARCHIVAL: 'data-archival',
  FILE_UPLOAD: 'file-upload',
  FILE_VERIFY: 'file-verify',
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
        // 连接/保活超时，避免 Redis 不可用时无限挂起
        connectTimeout: 10 * 1000,
        keepAlive: 10 * 1000,
        // 重连退避上限提高到 5s，减少 Redis 长时间不可用时的无效重连频率
        retryStrategy: (times: number) => Math.min(times * 500, 5000),
        // 可选 TLS：设置 REDIS_TLS=true 启用（托管 Redis 通常需要）
        ...(process.env.REDIS_TLS === 'true'
          ? {
              tls: {
                rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false',
              },
            }
          : {}),
      },
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.METRICS_AGGREGATION },
      { name: QUEUE_NAMES.ATTACK_DETECTION },
      { name: QUEUE_NAMES.ALERT_EVALUATION },
      { name: QUEUE_NAMES.BASELINE_CALCULATION },
      { name: QUEUE_NAMES.DATA_ARCHIVAL },
      { name: QUEUE_NAMES.FILE_UPLOAD },
      { name: QUEUE_NAMES.FILE_VERIFY },
    ),
  ],
  exports: [BullModule],
})
export class BullQueueModule {}
