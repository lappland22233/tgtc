import { Logger, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlertModule } from '../alert/alert.module';
import { BullQueueModule } from '../jobs/bull-queue.module';
import { File } from '../common/entities/file.entity';
import { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';
import { TelegramMirrorRule } from '../common/entities/telegram-mirror-rule.entity';
import { TelegramMirrorTask } from '../common/entities/telegram-mirror-task.entity';
import { TelegramMainChatAnchor } from '../common/entities/telegram-main-chat-anchor.entity';
import { TelegramAccountsModule } from '../telegram-accounts/telegram-accounts.module';
import { TelegramAccountPoolModule } from '../telegram-account-pool/telegram-account-pool.module';
import { TelegramUserModule } from '../telegram-user/telegram-user.module';
import { TelegramMirrorController } from './telegram-mirror.controller';
import { TelegramMirrorConfigService } from './telegram-mirror-config.service';
import { TelegramMirrorTaskService } from './telegram-mirror-task.service';
import { TelegramMirrorSourceService } from './telegram-mirror-source.service';
import { TelegramMainChatAnchorService } from './telegram-main-chat-anchor.service';
import { TelegramUserCopyService } from './telegram-user-copy.service';
import { TelegramMirrorMetricsService } from './telegram-mirror-metrics.service';
import { TelegramMirrorAlertService } from './telegram-mirror-alert.service';
import { TelegramMirrorTriggerService } from './telegram-mirror-trigger.service';
import { TelegramMirrorBackfillService } from './telegram-mirror-backfill.service';
import { TelegramMirrorProcessor } from './telegram-mirror.processor';

/** 镜像告警采集间隔（毫秒） */
const MIRROR_ALERT_INTERVAL_MS = 60_000;

/**
 * 文件镜像备份模块。
 *
 * 依赖方向（单向，无环）：
 * - → `TelegramAccountsModule`（账号主数据、凭据解密、能力开关）
 * - → `TelegramAccountPoolModule`（账号级 Telegram 客户端、副本事实表、账号感知回源）
 * - → `TelegramUserModule`（MTProto 无源复制）
 * - → `BullQueueModule`（`telegram-mirror` 队列与消费者）
 *
 * `TelegramModule` 为 @Global（`TelegramService` 单账号链路）故无需显式导入。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TelegramMirrorRule,
      TelegramMirrorTask,
      File,
      TelegramBotFileGrant,
      TelegramMainChatAnchor,
    ]),
    BullQueueModule,
    AlertModule,
    TelegramAccountsModule,
    TelegramAccountPoolModule,
    TelegramUserModule,
  ],
  controllers: [TelegramMirrorController],
  providers: [
    TelegramMirrorConfigService,
    TelegramMirrorTaskService,
    TelegramMirrorSourceService,
    TelegramMainChatAnchorService,
    TelegramUserCopyService,
    TelegramMirrorMetricsService,
    TelegramMirrorAlertService,
    TelegramMirrorTriggerService,
    TelegramMirrorBackfillService,
    TelegramMirrorProcessor,
  ],
  exports: [
    TelegramMirrorConfigService,
    TelegramMirrorTriggerService,
    TelegramMirrorMetricsService,
  ],
})
export class TelegramMirrorModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TelegramMirrorModule.name);
  private alertTimer: NodeJS.Timeout | null = null;

  constructor(private readonly alerts: TelegramMirrorAlertService) {}

  /**
   * 镜像告警定时采集。
   *
   * 为什么在模块内驱动而不是新增 Bull 队列：单后端实例语义下，一个 unref 定时器
   * 足够且成本更低（与 `TelegramAccountPoolModule` 的告警采集保持一致）。
   * 无论镜像开关是否开启都会采集：任务状态是事实，告警需要能反映「关了开关但仍有积压」。
   */
  onModuleInit(): void {
    this.alertTimer = setInterval(() => void this.alerts.runOnce(), MIRROR_ALERT_INTERVAL_MS);
    this.alertTimer.unref?.();
    this.logger.log(`镜像告警采集已启用：每 ${MIRROR_ALERT_INTERVAL_MS / 1000}s 一次`);
  }

  onApplicationShutdown(): void {
    if (this.alertTimer) clearInterval(this.alertTimer);
    this.alertTimer = null;
  }
}
