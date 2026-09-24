import { Inject, Logger, Module, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlertModule } from '../alert/alert.module';
import { File } from '../common/entities/file.entity';
import { TelegramAccount } from '../common/entities/telegram-account.entity';
import { TelegramFileCopy } from '../common/entities/telegram-file-copy.entity';
import { TelegramMirrorRule } from '../common/entities/telegram-mirror-rule.entity';
import { TelegramReplicationAttempt } from '../common/entities/telegram-replication-attempt.entity';
import { TelegramAccountCredentialModule } from '../telegram-accounts/telegram-account-credential.module';
import { TelegramUserModule } from '../telegram-user/telegram-user.module';
import { AccountAwareDownloadService } from './account-aware-download.service';
import { AccountAwareUploadService } from './account-aware-upload.service';
import { DownloadCapacityPolicyService } from './download-capacity-policy.service';
import { FileCopyService } from './file-copy.service';
import { RelayCapabilityService } from './relay-capability.service';
import { ReplicationAttemptService } from './replication-attempt.service';
import { TelegramAccountClientService } from './telegram-account-client.service';
import { TelegramAccountPoolAlertService } from './telegram-account-pool-alert.service';
import { TelegramAccountPoolService } from './telegram-account-pool.service';
import { ReplicaTargetResolver } from './replica-target.resolver';
import { ReplicationClaimSweeperService } from './replication-claim-sweeper.service';
import { UserAccountDirectoryService } from './user-account-directory.service';
import { UserRelayService } from './user-relay.service';

/** 账号池告警采集间隔（毫秒） */
const ALERT_INTERVAL_MS = 60_000;
/** 副本记录清理间隔（毫秒） */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** 清理保留窗口：失败记录 / 悬挂记录 / 陈旧副本 */
const FAILED_RECORD_TTL_HOURS = 24;
const PENDING_RECORD_TTL_HOURS = 1;
const STALE_COPY_TTL_DAYS = 30;
/** 扩散轮次保留窗口：悬挂轮次收敛阈值 / 终态轮次保留期（与副本清理分开评审） */
const HANGING_ATTEMPT_TTL_HOURS = 2;
const TERMINAL_ATTEMPT_TTL_DAYS = 30;

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
 *
 * 依赖方向（刻意单向，避免循环）：
 * - → `TelegramUserModule`（MTProto 客户端，叶子模块）——用户账号中继（策略 B）需要；
 * - → `TelegramAccountCredentialModule`（凭据解密，叶子模块）——用户账号 session 解密需要；
 * - → 直接注入 `TelegramAccount` / `File` 实体仓库读取账号与逻辑文件
 *   （**严禁** import `TelegramAccountsModule`，否则与账号管理模块成环）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TelegramFileCopy,
      TelegramAccount,
      File,
      TelegramMirrorRule,
      TelegramReplicationAttempt,
    ]),
    AlertModule,
    TelegramUserModule,
    TelegramAccountCredentialModule,
  ],
  providers: [
    TelegramAccountPoolService,
    TelegramAccountClientService,
    FileCopyService,
    UserAccountDirectoryService,
    UserRelayService,
    // 扩散轮次持久化：策略 B 的状态机、指标与清理的唯一写入方
    ReplicationAttemptService,
    // 中继能力快照与预检：后台「现在缺哪一项、怎么处理」的唯一事实来源
    RelayCapabilityService,
    AccountAwareDownloadService,
    AccountAwareUploadService,
    TelegramAccountPoolAlertService,
    // 统一的副本目标解析：全部下载入口（Web / Bot 公开下载 / 镜像回源）共用
    ReplicaTargetResolver,
    // 全局权重预算按有效 Bot 数自动扩缩容（带闸门与审计）
    DownloadCapacityPolicyService,
    // 认领窗口清扫：把「中继成功、等待群内 Bot 认领」的轮次结算到终态
    // （下载路径不再触发扩散，没有清扫会留下永远停放在 waiting_claims 的轮次）
    ReplicationClaimSweeperService,
  ],
  exports: [
    TelegramAccountPoolService,
    TelegramAccountClientService,
    FileCopyService,
    UserAccountDirectoryService,
    UserRelayService,
    ReplicationAttemptService,
    RelayCapabilityService,
    AccountAwareDownloadService,
    AccountAwareUploadService,
    TelegramAccountPoolAlertService,
    ReplicaTargetResolver,
    DownloadCapacityPolicyService,
  ],
})
export class TelegramAccountPoolModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TelegramAccountPoolModule.name);
  private alertTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  /** 账号就绪检查只做一次（启动或首次热开启，二者取先到者） */
  private accountsVerified = false;

  constructor(
    private readonly pool: TelegramAccountPoolService,
    private readonly client: TelegramAccountClientService,
    private readonly copies: FileCopyService,
    private readonly alerts: TelegramAccountPoolAlertService,
    // 可选（单测直接构造模块时缺省）：全局权重预算自动扩缩容评估。
    // 必须显式 `@Inject(X)`：`X | null` 联合类型发出的是 `Object`，
    // 否则 `@Optional()` 会把解析失败静默降级成 `null`（扩缩容定时器永不装配）。
    @Optional() @Inject(DownloadCapacityPolicyService)
    private readonly capacity: DownloadCapacityPolicyService | null = null,
    // 可选（同上）：扩散轮次清理。缺失时只是不清理轮次表，不影响扩散主链路。
    @Optional() @Inject(ReplicationAttemptService)
    private readonly attempts: ReplicationAttemptService | null = null,
  ) {
    this.pool.registerProbe(async (accountId: string) => {
      const config = this.pool.getConfig(accountId);
      if (!config) return { ok: false, error: '账号配置不存在' };
      return this.client.getMe(accountId, config.token);
    });

    // 热开启（env 关闭 → 面板开启）后补装后台定时任务与账号就绪检查。
    // 没有这个回调时，本模块的告警采集与副本清理会在整条热开启部署路径上永不启动。
    this.pool.registerActiveHook(() => {
      this.ensureRuntimeTimers();
      void this.verifyAccountsOnce();
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
    if (this.pool.isActive()) await this.verifyAccountsOnce();
    this.ensureRuntimeTimers();
  }

  /**
   * 装配后台定时任务（幂等，可重复调用）。
   *
   * 为什么必须幂等且可被热开启唤醒：`env 默认关闭 + 后台热开启`是推荐部署路径
   * （见 `TelegramAccountPoolService` 与后台开关的说明），若这里只按启动时的
   * `isActive()` 早退，热开启后告警采集与副本清理就永远不会启动——表现为
   * 「账号池看着在跑，但运行态告警静默、telegram_file_copies 无界增长」，
   * 与入站轮询那次 P0 同属「共享状态只在其中一条分支初始化」的静默失效。
   */
  private ensureRuntimeTimers(): void {
    if (!this.pool.isActive()) return;

    // 运行态告警：把「账号冷却 / 回退率 / 复制失败 / 回复失败」转为告警事件
    if (!this.alertTimer) {
      this.alertTimer = setInterval(() => void this.alerts.runOnce(), ALERT_INTERVAL_MS);
      this.alertTimer.unref?.();
    }

    if (!this.cleanupTimer) {
      // 副本记录生命周期清理（策略见 FileCopyService.purgeStale）
      this.logger.log(
        `副本清理策略已启用：每 ${CLEANUP_INTERVAL_MS / 60_000} 分钟一次；`
        + `保留窗口 failed=${FAILED_RECORD_TTL_HOURS}h pending=${PENDING_RECORD_TTL_HOURS}h stale=${STALE_COPY_TTL_DAYS}d`,
      );
      this.cleanupTimer = setInterval(() => void this.runCleanup(), CLEANUP_INTERVAL_MS);
      this.cleanupTimer.unref?.();
    }

    // 全局权重预算自动扩缩容：与告警/清理同属「热开启必须补装」的模块级定时器，
    // 否则「env 默认关闭 + 后台热开启」路径上预算永远不会随有效 Bot 数扩容。
    this.capacity?.ensureTimer();
  }

  /**
   * 账号就绪检查（只做一次）。
   *
   * 正常启动与热开启都可能成为「账号池首次可用」的时刻，两条路径都会调用这里；
   * 用一次性标志避免同一批账号被重复 `getChat` 校验（热开启回调会被周期性刷新唤醒）。
   */
  private async verifyAccountsOnce(): Promise<void> {
    if (this.accountsVerified) return;
    this.accountsVerified = true;
    await this.verifyAccounts();
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

    // 扩散轮次清理：先收敛悬挂轮次，再按保留窗口删除终态行（内部自带降级标记，不抛错）
    try {
      await this.attempts?.purgeStale({
        activeBefore: new Date(now - HANGING_ATTEMPT_TTL_HOURS * 3_600_000),
        terminalBefore: new Date(now - TERMINAL_ATTEMPT_TTL_DAYS * 86_400_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`扩散轮次清理失败（忽略，下轮重试）: ${message}`);
    }
  }
}
