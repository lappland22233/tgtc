import { Logger, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlertModule } from '../alert/alert.module';
import { TelegramFileCopy } from '../common/entities/telegram-file-copy.entity';
import { AccountAwareDownloadService } from './account-aware-download.service';
import { AccountAwareUploadService } from './account-aware-upload.service';
import { FileCopyService } from './file-copy.service';
import { TelegramAccountClientService } from './telegram-account-client.service';
import { TelegramAccountPoolAlertService } from './telegram-account-pool-alert.service';
import { TelegramAccountPoolService } from './telegram-account-pool.service';
import { UserRelayService } from './user-relay.service';

/** 账号池告警采集间隔（毫秒） */
const ALERT_INTERVAL_MS = 60_000;
/** 副本记录清理间隔（毫秒） */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** 清理保留窗口：失败记录 / 悬挂记录 / 陈旧副本 */
const FAILED_RECORD_TTL_HOURS = 24;
const PENDING_RECORD_TTL_HOURS = 1;
const STALE_COPY_TTL_DAYS = 30;

/**
 * Bot 账号池模块（多账号上传/回源）。
 *
 * 启用条件：`TELEGRAM_ACCOUNT_POOL_ENABLED=true` 且能解析出至少一个账号。
 * 未启用时本模块的所有服务都处于「不激活」状态，调用方按原单账号链路运行，
 * 且不启动任何定时器（零额外开销）。
 *
 * 装配说明：
 * - 在模块构造函数里把「健康探测」注册给账号池——探测函数需要
 *   `TelegramAccountClientService`，若写进 `TelegramAccountPoolService` 的构造函数
 *   会形成循环依赖，故用注册回调的方式解耦；
 * - 告警与副本清理按固定间隔在本模块内驱动（复用单实例约束，不引入新队列）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([TelegramFileCopy]), AlertModule],
  providers: [
    TelegramAccountPoolService,
    TelegramAccountClientService,
    FileCopyService,
    UserRelayService,
    AccountAwareDownloadService,
    AccountAwareUploadService,
    TelegramAccountPoolAlertService,
  ],
  exports: [
    TelegramAccountPoolService,
    TelegramAccountClientService,
    FileCopyService,
    UserRelayService,
    AccountAwareDownloadService,
    AccountAwareUploadService,
    TelegramAccountPoolAlertService,
  ],
})
export class TelegramAccountPoolModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TelegramAccountPoolModule.name);
  private alertTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: TelegramAccountPoolService,
    private readonly client: TelegramAccountClientService,
    private readonly copies: FileCopyService,
    private readonly alerts: TelegramAccountPoolAlertService,
  ) {
    this.pool.registerProbe(async (accountId: string) => {
      const config = this.pool.getConfig(accountId);
      if (!config) return { ok: false, error: '账号配置不存在' };
      return this.client.getMe(accountId, config.token);
    });
  }

  /**
   * 启动期账号就绪检查 + 后台定时任务装配。
   *
   * 检查为什么必要：副本扩散是把字节用目标账号重新上传到它自己的 `storageChatId`；
   * chatId 写错或 Bot 未被加入该群时，整批复制都会失败且在运行期才暴露。
   *
   * 失败只记录 error、不阻断启动：账号池是可选增强，阻断启动会让单账号部署无法升级
   * （真正的「启用了但不可用」由启动预检与诊断接口区分）。Webhook 冲突检查在
   * `TelegramBotPollingService` 中按账号执行。
   */
  async onModuleInit(): Promise<void> {
    if (!this.pool.isActive()) return;

    await this.verifyAccounts();

    // 运行态告警：把「账号冷却 / 回退率 / 复制失败 / 回复失败」转为告警事件
    this.alertTimer = setInterval(() => void this.alerts.runOnce(), ALERT_INTERVAL_MS);
    this.alertTimer.unref?.();

    // 副本记录生命周期清理（策略见 FileCopyService.purgeStale）
    this.logger.log(
      `副本清理策略已启用：每 ${CLEANUP_INTERVAL_MS / 60_000} 分钟一次；`
      + `保留窗口 failed=${FAILED_RECORD_TTL_HOURS}h pending=${PENDING_RECORD_TTL_HOURS}h stale=${STALE_COPY_TTL_DAYS}d`,
    );
    this.cleanupTimer = setInterval(() => void this.runCleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.alertTimer) clearInterval(this.alertTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.alertTimer = null;
    this.cleanupTimer = null;
  }

  private async verifyAccounts(): Promise<void> {
    for (const accountId of this.pool.ids()) {
      const account = this.pool.getConfig(accountId);
      if (!account) continue;
      if (!account.chatId) {
        this.logger.error(
          `账号 ${accountId} 未配置存储 Chat（chatId），副本扩散与副本上传将不可用`,
        );
        continue;
      }
      try {
        const chat = await this.client.getChat(accountId, account.token, account.chatId);
        this.logger.log(
          `账号 ${accountId} 存储 Chat 校验通过（type=${chat.type}${chat.title ? `，${chat.title}` : ''}）`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `账号 ${accountId} 存储 Chat 校验失败（chatId=${account.chatId}）：${message}`
          + '——请确认该 chat 存在，且已将该 Bot 加入/授权。',
        );
      }
    }
  }

  private async runCleanup(): Promise<void> {
    const now = Date.now();
    try {
      await this.copies.purgeStale({
        failedBefore: new Date(now - FAILED_RECORD_TTL_HOURS * 3_600_000),
        pendingBefore: new Date(now - PENDING_RECORD_TTL_HOURS * 3_600_000),
        staleReadyBefore: new Date(now - STALE_COPY_TTL_DAYS * 86_400_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`副本记录清理失败（忽略，下轮重试）: ${message}`);
    }
  }
}
