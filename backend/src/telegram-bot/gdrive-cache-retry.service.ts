import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AlertLevel } from '../common/entities/alert.entity';
import { AlertEngineService } from '../alert/alert-engine.service';
import { GDRIVE_CACHE_BACKLOG_THRESHOLD } from '../common/utils/gdrive-cache-backoff';
import { FileService } from '../file/file.service';
import { DownloadResourceCoordinatorService } from '../file/download-resource-coordinator.service';
import { StorageRouterService } from '../storage/storage-router.service';
import { TelegramBotConfigService } from './telegram-bot-config.service';
import { TelegramBotDispatchService } from './telegram-bot-dispatch.service';
import { TelegramBotGrantService } from './telegram-bot-grant.service';

/** 每轮最多重试的网页文件数 */
const FILES_PER_RUN = 3;
/** 每轮最多重试的 Bot 直链数 */
const GRANTS_PER_RUN = 5;

/**
 * Google 双写重试调度。
 *
 * 覆盖两条路径：
 * - `files`（网页上传）：失败后本地临时文件已被清理，重试从 Telegram 账号池回源；
 * - `telegram_bot_file_grants`（Bot 直链）：从产生该 `file_id` 的源账号回源（fail-closed）。
 *
 * 只在「Telegram 存储模式 + Google 缓存模式开启」时工作；每轮条数与并发都很小，
 * 避免重试反过来抢占前台下载的上行预算。积压超过阈值时触发 WARNING 告警。
 */
@Injectable()
export class GDriveCacheRetryService {
  private readonly logger = new Logger(GDriveCacheRetryService.name);
  private running = false;

  constructor(
    private readonly botConfig: TelegramBotConfigService,
    private readonly dispatch: TelegramBotDispatchService,
    private readonly fileService: FileService,
    private readonly grantService: TelegramBotGrantService,
    private readonly storageRouter: StorageRouterService,
    @Optional() @Inject(DownloadResourceCoordinatorService)
    private readonly downloadResources: DownloadResourceCoordinatorService | null = null,
    @Optional() @Inject(AlertEngineService)
    private readonly alertEngine: AlertEngineService | null = null,
  ) {}

  @Cron('*/2 * * * *')
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const config = await this.botConfig.getConfig();
      if (config.storageMode !== 'telegram') return;
      if (!(await this.storageRouter.isGDriveCacheModeEnabled().catch(() => false))) return;

      await this.retryWebFiles();
      await this.dispatch.retryDueGDriveCacheMirrors(GRANTS_PER_RUN);
      await this.maybeAlert();
    } catch (error) {
      this.logger.warn(
        `Google 双写重试轮次失败（下轮继续）：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async retryWebFiles(): Promise<void> {
    const ids = await this.fileService.findDueGDriveCacheMirrorIds(FILES_PER_RUN);
    for (const id of ids) {
      let lease: Awaited<ReturnType<DownloadResourceCoordinatorService['acquireUpstreamSlot']>> | null = null;
      try {
        // 与前台下载共用全局上行预算：重试是后台补课，不得抢占用户带宽
        lease = this.downloadResources
          ? await this.downloadResources.acquireUpstreamSlot({ waitTimeoutMs: 30_000 })
          : null;
        await this.fileService.mirrorGDriveCache(id);
      } catch (error) {
        // 单个文件失败（上行繁忙/回源失败）不得中断整轮，下轮继续
        this.logger.warn(
          `网页文件 ${id} Google 双写重试失败（下轮继续）：${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        lease?.release();
      }
    }
  }

  private async maybeAlert(): Promise<void> {
    if (!this.alertEngine) return;
    try {
      const [files, grants] = await Promise.all([
        this.fileService.countDueGDriveCacheMirrors(),
        this.grantService.countDueGDriveCacheMirrors(),
      ]);
      const backlog = files + grants;
      if (backlog <= GDRIVE_CACHE_BACKLOG_THRESHOLD) return;
      await this.alertEngine.createAlerts([{
        ruleId: 'GDRIVE_CACHE_BACKLOG',
        level: AlertLevel.WARNING,
        title: 'Google 双写积压',
        message: `有 ${backlog} 个文件的 Google 双写处于待重试/失败状态（网页 ${files}，Bot 直链 ${grants}），`
          + `超过阈值 ${GDRIVE_CACHE_BACKLOG_THRESHOLD}；请检查 GDrive 账号池容量、凭据与网络`,
        context: { files, grants, threshold: GDRIVE_CACHE_BACKLOG_THRESHOLD },
      }]);
    } catch (error) {
      this.logger.debug(
        `Google 双写积压告警评估失败（忽略）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
