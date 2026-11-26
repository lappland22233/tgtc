import { BeforeApplicationShutdown, Inject, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'fs';
import { mkdir, open, stat, unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { PassThrough, Readable } from 'stream';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { TelegramService } from '../telegram/telegram.service';
import { TelegramRateLimitError } from '../telegram/telegram.errors';
import { AuditService } from '../common/services/audit.service';
import { AuditStatus } from '../common/entities/audit-log.entity';
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate, TelegramUser } from '../telegram/telegram.types';
import { FileCopyService } from '../telegram-account-pool/file-copy.service';
import { ReplicationAttemptService } from '../telegram-account-pool/replication-attempt.service';
import { TelegramAccountClientService, TelegramAccountError } from '../telegram-account-pool/telegram-account-client.service';
import { TelegramAccountPoolService } from '../telegram-account-pool/telegram-account-pool.service';
import { AccountAwareDownloadService } from '../telegram-account-pool/account-aware-download.service';
import type { AccountAwareDownloadFailure } from '../telegram-account-pool/account-aware-stream.types';
import { StorageRouterService } from '../storage/storage-router.service';
import { GDRIVE_MULTIPART_MAX_BYTES, StorageUploadSourceError } from '../storage/storage.types';
import { GDRIVE_CACHE_LEASE_MS } from '../common/utils/gdrive-cache-backoff';
import type { StorageUploadParams, StorageUploadReceipt } from '../storage/storage.types';
import { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';
import { TelegramBotInboundTask } from '../common/entities/telegram-bot-inbound-task.entity';
import { redactBotToken } from '../common/utils/sensitive-data';
import { TelegramMirrorConfigService } from '../telegram-mirror/telegram-mirror-config.service';
import { TelegramMirrorTriggerService } from '../telegram-mirror/telegram-mirror-trigger.service';
import { DownloadResourceCoordinatorService, DownloadReservation, DownloadResourceException } from '../file/download-resource-coordinator.service';
import type { DownloadUpstreamLease } from '../file/download-resource-coordinator.service';
import { UploadDiskBudgetService } from '../file/upload-disk-budget.service';
import { BotTransferTrackerService } from './bot-transfer-tracker.service';
import { TelegramBotConfigService } from './telegram-bot-config.service';
import { IssueGrantInput, TelegramBotGrantService } from './telegram-bot-grant.service';
import { TelegramBotInboundQueueService } from './telegram-bot-inbound-queue.service';
import { TelegramBotQuotaService } from './telegram-bot-quota.service';
import { TelegramBotAdminService } from './telegram-bot-admin.service';
import { TelegramBotIdentity } from './telegram-bot.types';
import type { RenderedMessage } from './telegram-bot.message-renderer';
import { renderQueueNotice, renderHelp, renderQuota, renderQuotaDenied, renderLinkQuery, renderLinkReady, renderWhitelist, renderNotice } from './telegram-bot.message-renderer';
import type { TelegramTextSendOptions } from '../telegram/telegram.types';
import { TelegramRequestRejectedError } from '../telegram/telegram.errors';

/** Telegram 单条消息文本上限（预留截断余量） */
const MAX_MESSAGE_LENGTH = 3800;
/** /link_query 结果最多展示条数（避免刷屏与超长消息） */
const MAX_LINK_QUERY_RESULTS = 20;
const QUEUE_POLL_MS = 500;
const LEASE_RENEWAL_MS = 1_000;
const NOTICE_INTERVAL_MS = 1_100;
const NOTICE_RETRY_MS = 5_000;
const BANNED_TEXT = '此 Telegram 账号已被停用，无法创建下载链接。';
const DISK_UNAVAILABLE_TEXT = '服务器临时磁盘空间不足，无法转存文件，请稍后重试。';

class InboundPersistenceError extends Error {
  constructor(cause: unknown) {
    super('Bot 收件队列写入失败', { cause });
  }
}

class TelegramTransferBackoff extends Error {
  constructor(readonly delayMs: number) { super('Telegram 回源暂时受限'); }
}

function telegramBackoffMs(error: unknown): number | null {
  if (error instanceof TelegramTransferBackoff) return error.delayMs;
  if (error instanceof TelegramRateLimitError) return error.retryAfterSeconds * 1_000;
  if (error instanceof TelegramAccountError && error.kind === 'flood') {
    return Math.max(1, error.retryAfterSeconds ?? 3) * 1_000;
  }
  const response = (error as { response?: { status?: number; data?: { parameters?: { retry_after?: number } } } })?.response;
  if (response?.status !== 429) return null;
  return Math.max(1, Number(response.data?.parameters?.retry_after) || 3) * 1_000;
}

/**
 * 单条更新的上下文。
 *
 * `accountId` 只在账号池模式下存在，表示**收到该消息的 Bot 账号**；
 * 它必须贯穿分发全链路，用于：
 * - 由同一账号回复用户（跨账号代发会造成身份错用）；
 * - 把该账号的 `file_id` 归属写入 Grant（回退安全锚点）与副本表。
 */
export interface BotUpdateContext {
  accountId?: string;
  receiverBotId?: string;
}

/**
 * grant 命名空间认领归因的输入（由 `registerInboundCopyAndForward` 收集）。
 *
 * 为什么单独打包：grant 归因只在「消息来自启用中的镜像规则目标群」时执行，
 * 且需要该账号自己的 `file_id` 与消息锚点；集中传入避免参数继续膨胀。
 */
interface GrantClaimAttribution {
  /** 该账号自己的 file_id（写 grant 副本行用；禁止跨账号借用） */
  telegramFileId: string;
  /** 消息 ID（副本行的转发锚点） */
  messageId: string;
  fileSize: number | null;
  /** 消息是否来自启用中的镜像规则目标群（非中继来源不得抬高 grant 命名空间计数） */
  fromRelayTarget: boolean;
  /** 桥接是否命中站内逻辑文件（决定 grant 副本行的 source 标注） */
  bridged: boolean;
}

/**
 * 入站更新分发：私聊校验、命令路由、document 提取、配额判定与直链签发。
 *
 * 处理顺序（重要）：
 *   私聊校验 → 幂等命中 → 命令 → document 提取 → 域名解析(fail-closed) → 配额 → 签发 → 回复
 * 域名解析在配额扣减之前，避免因管理员未配置域名而白白消耗用户额度。
 *
 * 多账号契约（账号池模式）：
 * - **谁收到消息谁回复**：所有回复都走 `reply(...)`，按 `accountId` 用该账号的 Token 发送；
 * - **谁收到文件谁登记**：`file_unique_id` 为跨账号稳定主键，登记该账号的副本；
 * - 回复失败**不得**改用默认账号代发，只记结构化日志与计数（fail-closed）。
 *
 * 不限制文件大小：`MAX_FILE_SIZE` 属于本站上传策略，Bot 文件不经上传链路；
 * 本地 Bot API（`--local` + 流式端点）对可服务的文件大小无上限。
 */
@Injectable()
export class TelegramBotDispatchService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(TelegramBotDispatchService.name);
  /** 首个异步操作之前登记，在文档处理及其后台转存结束后释放。 */
  private readonly activeTransfers = new Map<string, { abortController: AbortController; promise: Promise<void> }>();
  /** 会话级在途转存计数 (Bot ID + chatId -> 活跃转存数)，用于感知用户当前是否有正在处理的直链生成 */
  private readonly activeTransfersByChat = new Map<string, number>();
  /** 会话级等待提示回复冷却时间戳 (Bot ID + chatId -> 最近提示时间戳)，防止用户刷屏 */
  private readonly chatNoticeCooldowns = new Map<string, number>();
  /** 等待期间用户发言提示防刷冷却时间（15 秒） */
  private readonly inFlightNoticeCooldownMs = 15_000;
  private isShuttingDown = false;
  private shutdownDrainTimeoutMs = 10_000;
  private queueTimer?: NodeJS.Timeout;
  private readonly queueWorkers = new Map<string, Promise<void>>();
  private readonly noticeWorkers = new Map<string, Promise<void>>();
  private readonly nextNoticeAt = new Map<string, number>();
  private readonly telegramCooldownUntil = new Map<string, number>();

  onApplicationBootstrap(): void {
    const enabled = this.configService?.get<string>('TELEGRAM_BOT_UPDATES_ENABLED');
    if (enabled?.trim().toLowerCase() === 'true') {
      this.queueTimer = setInterval(() => this.pollQueue(), QUEUE_POLL_MS);
      this.queueTimer.unref();
      this.pollQueue();
    }
  }

  getActiveTransferCount(): number {
    return this.activeTransfers.size;
  }

  setShutdownDrainTimeoutMs(ms: number): void {
    this.shutdownDrainTimeoutMs = ms;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.isShuttingDown = true;
    clearInterval(this.queueTimer);
    const workers = [...this.queueWorkers.values(), ...this.noticeWorkers.values()];
    if (this.activeTransfers.size === 0 && workers.length === 0) return;

    const count = this.activeTransfers.size;
    this.logger.log(`正在等待 ${count} 个后台转存任务排空（最多 ${this.shutdownDrainTimeoutMs / 1000} 秒）...`);

    const allPromises = [...workers, ...Array.from(this.activeTransfers.values()).map((t) => t.promise)];
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.shutdownDrainTimeoutMs);
    });
    const drained = await Promise.race([
      Promise.allSettled(allPromises).then(() => true),
      timeoutPromise,
    ]);
    if (timer) clearTimeout(timer);

    if (!drained && this.activeTransfers.size > 0) {
      this.logger.warn(
        `后台转存任务未在规定时间内完成，正在中止剩余 ${this.activeTransfers.size} 个任务...`,
      );
      for (const transfer of this.activeTransfers.values()) {
        transfer.abortController.abort();
      }
      const remainingPromises = Array.from(this.activeTransfers.values()).map((t) => t.promise);
      let abortTimer: NodeJS.Timeout | null = null;
      const abortTimeoutPromise = new Promise<void>((resolve) => {
        abortTimer = setTimeout(resolve, 3_000);
      });
      await Promise.race([
        Promise.allSettled(remainingPromises),
        abortTimeoutPromise,
      ]);
      if (abortTimer) clearTimeout(abortTimer);
    }
  }

  constructor(
    private readonly telegramService: TelegramService,
    private readonly botConfigService: TelegramBotConfigService,
    private readonly quotaService: TelegramBotQuotaService,
    private readonly grantService: TelegramBotGrantService,
    private readonly adminService: TelegramBotAdminService,
    private readonly auditService: AuditService,
    private readonly inboundQueue: TelegramBotInboundQueueService,
    // 以下参数仅用于「账号池」增强路径；未启用时全部为可选依赖（保持原单账号行为）。
    //
    // 必须显式 `@Inject(X)`：`X | null` 联合类型在运行时只会发出 `Object`，
    // 按类型拿不到服务类 token，`@Optional()` 会把解析失败静默降级成 `null`
    // （既有的「账号池增强全部不生效但不报错」即由此产生）。
    @Optional() @Inject(TelegramAccountPoolService)
    private readonly pool: TelegramAccountPoolService | null = null,
    @Optional() @Inject(FileCopyService)
    private readonly copies: FileCopyService | null = null,
    @Optional() @Inject(TelegramAccountClientService)
    private readonly accountClient: TelegramAccountClientService | null = null,
    @Optional() @Inject(ConfigService)
    private readonly configService: ConfigService | null = null,
    // 镜像备份触发（可选依赖：未装配或未启用时零行为变化）
    @Optional() @Inject(TelegramMirrorTriggerService)
    private readonly mirrorTrigger: TelegramMirrorTriggerService | null = null,
    // 镜像规则读取（可选依赖）：仅用于识别「消息来自备份群」以抑制归档转发放大
    @Optional() @Inject(TelegramMirrorConfigService)
    private readonly mirrorConfig: TelegramMirrorConfigService | null = null,
    // 扩散轮次回写（可选依赖）：把 Bot 认领事件落到轮次记录，让「中继 → 认领」闭环可查询
    @Optional() @Inject(ReplicationAttemptService)
    private readonly attempts: ReplicationAttemptService | null = null,
    // 账号池回源拉流（可选依赖，纯 Google 存储模式转存取源时复用）
    @Optional() @Inject(AccountAwareDownloadService)
    private readonly accountPoolDownload: AccountAwareDownloadService | null = null,
    // 可插拔存储路由（纯 Google 存储模式直传 GDrive 驱动池）
    @Optional() @Inject(StorageRouterService)
    private readonly storageRouter: StorageRouterService | null = null,
    // 下载/转存磁盘容量预约协调器（防止并发打满磁盘）
    @Optional() @Inject(DownloadResourceCoordinatorService)
    private readonly downloadResources: DownloadResourceCoordinatorService | null = null,
    // 严格上传磁盘预算服务（严格无缓存模式防超卖）
    @Optional() @Inject(UploadDiskBudgetService)
    private readonly uploadDiskBudget: UploadDiskBudgetService | null = null,
    // 活跃转存临时文件租约追踪（防止长耗时大文件转存被定时清理误删）
    @Optional() @Inject(BotTransferTrackerService)
    private readonly transferTracker: BotTransferTrackerService | null = null,
  ) {}

  /** 处理单条更新（异常不外抛，避免中断轮询循环） */
  async handleUpdate(update: TelegramUpdate, context?: BotUpdateContext): Promise<void> {
    const accountId = context?.accountId;
    try {
      // 回调先于 message 判断：callback_query 没有 message 字段时会在此被正确分流
      if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query, accountId);
        return;
      }
      // 镜像群/主群可能是频道，频道帖以 `channel_post` 到达；仅用于非私聊的副本登记，
      // 私聊命令与配额一律只处理 `message`（频道帖没有用户身份，绝不允许进入私聊链路）。
      const message = update.message ?? update.channel_post;
      if (!message) return;
      // D7：仅私聊；群组/频道消息静默忽略，不回复、不扣配额
      if (!message.chat || message.chat.type !== 'private') {
        // 池化模式的跨账号可见性补登记：若该消息来自用户账号中继（群/频道），
        // 每个 bot 会各自收到一次 → 在此登记「本账号的副本」（策略 B 的完成条件）。
        if (message.document?.file_id) {
          await this.registerInboundCopyAndForward(message, accountId);
        }
        return;
      }
      if (!message.from || message.from.is_bot) return;

      const identity = this.normalizeIdentity(message.from);
      const chatId = String(message.chat.id);
      const text = (message.text || '').trim();

      if (text.startsWith('/')) {
        await this.handleCommand(message, identity, text, accountId);
        return;
      }
      const receiverBotId = context?.receiverBotId ?? (accountId
        ? this.pool?.getConfig(accountId)?.token.split(':')[0]
        : this.defaultSourceAccountId());
      if (message.document) {
        if (!receiverBotId || !/^\d+$/.test(receiverBotId)) {
          this.logger.warn('无法确认接收文件的 Bot 身份，跳过签发');
          return;
        }
        await this.handleDocument(message, identity, receiverBotId, accountId);
        return;
      }
      if (this.isNonDocumentMedia(message)) {
        await this.reply(
          chatId,
          '请以「文件」方式发送：在 Telegram 中选择附件 → 文件，而不是图片/视频。',
          message.message_id,
          accountId,
        );
        return;
      }
      const conversationKey = `${receiverBotId}:${chatId}`;
      if (text && this.hasActiveTransferForChat(conversationKey)) {
        await this.handleInFlightChatNotice(conversationKey, chatId, message.message_id, accountId);
        return;
      }
      await this.reply(chatId, this.buildHelpText(identity), message.message_id, accountId);
    } catch (error) {
      if (error instanceof InboundPersistenceError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`处理 Bot 更新失败（已忽略）: ${message}`);
    }
  }

  /**
   * 内联按钮回调（当前仅「取消处理」）。
   *
   * 安全约束：`callback_data` 完全不可信——只当作任务 ID，**必须**重新从库里取任务并核对
   * 发起者就是该任务的 telegramUserId，否则任何人都能取消别人的任务。
   */
  private async handleCallbackQuery(query: TelegramCallbackQuery, accountId?: string): Promise<void> {
    const answer = (text: string, showAlert = false) => this.answerCallbackQuery(query.id, accountId, text, showAlert);

    if (!query.from || query.from.is_bot) return;
    const data = query.data ?? '';
    const [action, taskId] = data.split(':', 2);
    if (action !== 'bot_cancel' || !taskId) {
      await answer('该操作已失效。');
      return;
    }

    const task = await this.inboundQueue.findById(taskId);
    if (!task) {
      await answer('任务不存在或已被清理。');
      return;
    }
    // 越权防护：以任务归属为准，绝不信任按钮来源
    if (String(task.telegramUserId) !== String(query.from.id)) {
      this.logger.warn(`取消回调越权被拒（task=${taskId}, from=${query.from.id}）`);
      await answer('无权取消该任务。', true);
      return;
    }
    if (task.status !== 'queued' && task.status !== 'running') {
      await answer('任务已结束，无需取消。');
      return;
    }

    const result = await this.inboundQueue.cancelOne(taskId);
    if (!result?.changed) {
      await answer('任务已结束，无需取消。');
      return;
    }
    this.auditService.log({
      action: 'telegram_bot_task_cancelled',
      resourceType: 'telegram_bot_task',
      resourceId: taskId,
      status: AuditStatus.SUCCESS,
      metadata: {
        taskId,
        telegramUserId: task.telegramUserId,
        receiverBotId: task.receiverBotId,
        operator: `telegram:${query.from.id}`,
      },
    });
    await answer('已取消该文件的处理。');
  }

  /** 回应内联按钮回调；池化模式下必须用收到回调的那个 Bot 回应 */
  private async answerCallbackQuery(
    callbackQueryId: string,
    accountId: string | undefined,
    text: string,
    showAlert = false,
  ): Promise<void> {
    try {
      const account = accountId && this.pool?.isActive() ? this.pool.getConfig(accountId) : undefined;
      if (account && this.accountClient) {
        await this.accountClient.answerCallbackQuery(accountId!, account.token, callbackQueryId, { text, showAlert });
        return;
      }
      await this.telegramService.answerCallbackQuery(callbackQueryId, { text, showAlert });
    } catch (error) {
      // 回应失败不影响任务状态，仅记录——用户重新点一次即可
      this.logger.warn(
        `回应按钮回调失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private normalizeIdentity(user: TelegramUser): TelegramBotIdentity {
    const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
    return {
      telegramUserId: String(user.id),
      username: this.sanitize(user.username, 64, true),
      displayName: this.sanitize(displayName, 128, false),
    };
  }

  /** 审计字段清洗：去控制字符 + 截断（username 加 @ 前缀） */
  private sanitize(value: string | undefined, maxLength: number, withAt: boolean): string | null {
    if (!value) return null;
    const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
    if (!cleaned) return null;
    const prefixed = withAt ? `@${cleaned}` : cleaned;
    return prefixed.slice(0, maxLength);
  }

  private isNonDocumentMedia(message: TelegramMessage): boolean {
    return Boolean(
      (message.photo && message.photo.length > 0)
      || message.video
      || message.audio
      || message.voice
      || message.animation
      || message.sticker,
    );
  }

  // ---------------- 命令 ----------------

  private async handleCommand(
    message: TelegramMessage,
    identity: TelegramBotIdentity,
    rawText: string,
    accountId?: string,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    // 支持 /cmd@BotName 形式
    const [rawCommand, ...args] = rawText.split(/\s+/);
    const command = rawCommand.split('@')[0].toLowerCase();

    switch (command) {
      case '/start':
      case '/help':
        await this.reply(chatId, this.buildHelpText(identity), message.message_id, accountId);
        return;
      case '/id':
        await this.reply(
          chatId,
          renderNotice(`你的 Telegram 用户 ID：${identity.telegramUserId}`, { emphasize: [identity.telegramUserId] }),
          message.message_id,
          accountId,
        );
        return;
      case '/quota':
        await this.handleQuotaCommand(chatId, identity, message.message_id, accountId);
        return;
      case '/wl_add':
      case '/wl_remove':
      case '/wl_list':
      case '/link_query':
      case '/link_revoke':
        await this.handleAdminCommand(
          command,
          args,
          chatId,
          identity,
          message.message_id,
          message.chat.type,
          accountId,
        );
        return;
      default:
        await this.reply(
          chatId,
          renderNotice('未知命令，发送 /help 查看可用命令。', { emphasize: ['/help'] }),
          message.message_id,
          accountId,
        );
    }
  }

  private async handleQuotaCommand(
    chatId: string,
    identity: TelegramBotIdentity,
    replyToMessageId: number,
    accountId?: string,
  ): Promise<void> {
    const config = await this.botConfigService.getConfig();
    const whitelisted = await this.quotaService.isWhitelisted(identity.telegramUserId);
    if (whitelisted) {
      await this.reply(chatId, renderQuota({ whitelisted: true }), replyToMessageId, accountId);
      return;
    }
    const usageDate = this.quotaService.getBusinessDate(config.quotaTimezone);
    const used = await this.quotaService.getUsed(identity.telegramUserId, usageDate);
    const remaining = Math.max(0, config.dailyLimit - used);
    await this.reply(
      chatId,
      renderQuota({ whitelisted: false, used, limit: config.dailyLimit, remaining, timezone: config.quotaTimezone }),
      replyToMessageId,
      accountId,
    );
  }

  private async handleAdminCommand(
    command: string,
    args: string[],
    chatId: string,
    identity: TelegramBotIdentity,
    replyToMessageId: number,
    chatType: string,
    accountId?: string,
  ): Promise<void> {
    if (!this.adminService.isAdmin(identity.telegramUserId)) {
      // 越权：只回通用拒绝，且不泄露命令内容
      this.adminService.auditCommandDenied(identity, command, chatType);
      await this.reply(chatId, '该命令仅限管理员使用。', replyToMessageId, accountId);
      return;
    }

    switch (command) {
      case '/wl_add':
        await this.handleWhitelistAdd(args, chatId, identity, replyToMessageId, accountId);
        return;
      case '/wl_remove':
        await this.handleWhitelistRemove(args, chatId, identity, replyToMessageId, accountId);
        return;
      case '/wl_list':
        await this.handleWhitelistList(chatId, replyToMessageId, accountId);
        return;
      case '/link_query':
        await this.handleLinkQuery(args, chatId, identity, replyToMessageId, accountId);
        return;
      case '/link_revoke':
        await this.handleLinkRevoke(args, chatId, identity, replyToMessageId, accountId);
        return;
      default:
        await this.reply(
          chatId,
          renderNotice('未知命令，发送 /help 查看可用命令。', { emphasize: ['/help'] }),
          replyToMessageId,
          accountId,
        );
    }
  }

  private async handleWhitelistAdd(
    args: string[],
    chatId: string,
    identity: TelegramBotIdentity,
    replyToMessageId: number,
    accountId?: string,
  ): Promise<void> {
    const target = (args[0] || '').trim();
    if (!/^\d{1,20}$/.test(target)) {
      await this.reply(chatId, '用法：/wl_add <TG用户ID>', replyToMessageId, accountId);
      return;
    }
    const { created } = await this.adminService.addWhitelist(identity, target);
    await this.reply(
      chatId,
      created ? `已加入白名单：${target}` : `${target} 已在白名单中。`,
      replyToMessageId,
      accountId,
    );
  }

  private async handleWhitelistRemove(
    args: string[],
    chatId: string,
    identity: TelegramBotIdentity,
    replyToMessageId: number,
    accountId?: string,
  ): Promise<void> {
    const target = (args[0] || '').trim();
    if (!/^\d{1,20}$/.test(target)) {
      await this.reply(chatId, '用法：/wl_remove <TG用户ID>', replyToMessageId, accountId);
      return;
    }
    const removed = await this.adminService.removeWhitelist(identity, target);
    await this.reply(
      chatId,
      removed ? `已移出白名单：${target}` : `${target} 不在白名单中。`,
      replyToMessageId,
      accountId,
    );
  }

  private async handleWhitelistList(
    chatId: string,
    replyToMessageId: number,
    accountId?: string,
  ): Promise<void> {
    const list = await this.adminService.listWhitelist();
    if (list.length === 0) {
      await this.reply(chatId, renderWhitelist([], 0), replyToMessageId, accountId);
      return;
    }
    const shown = list.slice(0, MAX_LINK_QUERY_RESULTS);
    await this.reply(
      chatId,
      renderWhitelist(shown.map(item => item.telegramUserId), list.length),
      replyToMessageId,
      accountId,
    );
  }

  private async handleLinkQuery(
    args: string[],
    chatId: string,
    identity: TelegramBotIdentity,
    replyToMessageId: number,
    accountId?: string,
  ): Promise<void> {
    const target = (args[0] || '').trim();
    if (!/^\d{1,20}$/.test(target)) {
      await this.reply(chatId, '用法：/link_query <TG用户ID>', replyToMessageId, accountId);
      return;
    }
    const results = await this.adminService.queryLinks(identity, target);
    if (results.length === 0) {
      await this.reply(chatId, `${target} 当前没有有效的直链。`, replyToMessageId, accountId);
      return;
    }
    const shown = results.slice(0, MAX_LINK_QUERY_RESULTS);
    await this.reply(
      chatId,
      renderLinkQuery(
        target,
        shown.map(item => ({
          fileName: item.grant.fileName || '(未命名)',
          expiresAt: item.grant.expiresAt instanceof Date
            ? item.grant.expiresAt.toISOString()
            : String(item.grant.expiresAt),
          url: item.url,
          prefix: item.prefix,
        })),
        results.length,
      ),
      replyToMessageId,
      accountId,
    );
  }

  private async handleLinkRevoke(
    args: string[],
    chatId: string,
    identity: TelegramBotIdentity,
    replyToMessageId: number,
    accountId?: string,
  ): Promise<void> {
    const input = (args[0] || '').trim();
    if (!input) {
      await this.reply(chatId, '用法：/link_revoke <直链URL或Token>', replyToMessageId, accountId);
      return;
    }
    const result = await this.adminService.revokeByToken(identity, input);
    if (!result.ok) {
      await this.reply(
        chatId,
        result.reason === 'invalid_input' ? '无法解析直链，请粘贴完整直链 URL 或 Token。' : '未找到对应的直链（可能已过期或已撤销）。',
        replyToMessageId,
        accountId,
      );
      return;
    }
    await this.reply(chatId, renderNotice('直链已撤销，立即失效。', { emphasize: ['已撤销'] }), replyToMessageId, accountId);
  }

  // ---------------- 文件处理 ----------------

  /**
   * 账号池增强路径（仅池化模式生效，未启用时直接返回）：
   * 1. 登记「收到该文件的账号」副本 —— 逻辑主键必须用 Telegram `file_unique_id`
   *    （跨账号稳定），这样后续「按负载选一个账号回源」才有候选集合；
   * 2. **桥接**：把该入站副本同时写成「站内逻辑文件（`ownerType='file'`）」的副本，
   *    否则下载选号（按站内 `file.id` 查副本）永远看不到它，副本扩散形同虚设；
   * 3. 若配置了归档群，则用接收账号把消息转发到归档群（`TELEGRAM_ARCHIVE_CHAT_ID`）。
   *
   * **注意**：转发到群**不会**让其它 bot 拿到该文件（Telegram 规定 bot 看不到其它 bot 的消息）。
   * 跨账号共享只有一条链路——**用户账号中继**：持有源消息的 Bot 先把消息转发进**主群**
   * （落点持久化在 `telegram_main_chat_anchors`），用户账号再从主群服务端转发到各**镜像群**；
   * 镜像群内每个 Bot（管理员/关闭隐私模式）各自收到更新，在此处登记**自己账号的**
   * `file_id` 副本，这就是副本扩散的完成条件（转发成功本身不算）。
   * 转发到归档群只是审计/归属留痕。
   *
   * 放大抑制：来自**镜像群**或**主群**的消息**只登记副本**，不再归档转发——这两类群都是
   * 扩散落点，群内 N 个 Bot 会各自转发一次，把归档群消息量按 Bot 数放大（见
   * `shouldSuppressArchiveForward`）。
   */
  private async registerInboundCopyAndForward(
    message: TelegramMessage,
    accountId?: string,
  ): Promise<void> {
    const pool = this.pool;
    const copies = this.copies;
    if (!accountId || !pool?.isActive() || !copies) return;
    const doc = message.document;
    if (!doc?.file_id) return;
    const chatId = String(message.chat?.id ?? '');
    const messageId = String(message.message_id ?? '');

    // 逻辑主键必须是跨账号稳定的 `file_unique_id`；缺失时**绝不退化为 `file_id`**
    // （`file_id` 按账号隔离，用它当逻辑主键会把不同账号的文件错误聚合成同一逻辑文件）。
    // 缺失时跳过副本登记：该文件只能由「源账号」回源（降级路径），并计数 + 告警以便发现。
    const uniqueId = doc.file_unique_id;
    if (!uniqueId) {
      pool.bumpCounter('inboundRegistrationFailures');
      this.logger.warn(
        `账号 ${accountId} 收到的文件缺少 file_unique_id，已跳过副本登记`
        + '（该文件仅可由源账号回源，不参与跨账号扩散）',
      );
    } else {
      try {
        const fileSize = typeof doc.file_size === 'number' && doc.file_size > 0 ? doc.file_size : null;
        // 中继来源判定：只认**启用中**镜像规则的目标群，与 UserRelayService.resolveTargetChatId 同一口径
        const fromRelayTarget = await this.isEnabledMirrorTargetChat(chatId);

        // 桥接先做：它既决定这条入站副本能否被站内下载消费，也决定能否标注 relayed
        // （未命中该群消息与站内文件无关，属正常现象，只计数、不告警）
        const bridged = await copies.bridgeInboundCopyToLogicalFile({
          fileUniqueId: uniqueId,
          accountId,
          telegramFileId: doc.file_id,
          chatId,
          messageId,
          fileSize,
          source: fromRelayTarget ? 'relayed' : 'inbound',
        });
        if (!bridged.bridged) pool.bumpCounter('inboundBridgeMisses');

        // fileUnique 行：只有「中继来源 + 确实命中站内逻辑文件」才标注 relayed。
        // 否则普通备份群消息会被统计成「中继已生效」，后台观测数据直接失真。
        await copies.upsertReady({
          ownerType: 'fileUnique',
          ownerId: uniqueId,
          accountId,
          telegramFileId: doc.file_id,
          chatId,
          messageId,
          fileSize,
          source: fromRelayTarget && bridged.bridged ? 'relayed' : 'inbound',
        });
        this.logger.log(`已登记入站副本：账号 ${accountId} / fileUnique=${uniqueId.slice(0, 16)}…`);

        // 认领回写：让「中继 → 认领」闭环在后台可查询（找不到进行中轮次时静默返回）。
        // 必须带上「消息来自哪个群」：多镜像群场景下同一文件同时有多条活跃轮次，
        // 不带目标群会把 A 群的认领记到 B 群的轮次上，结算结论直接错。
        // 同时传入 grant 归因所需的信息（file_id / 消息锚点 / 中继来源判定），
        // 由 recordRelayClaim 统一完成三个命名空间的回写。
        await this.recordRelayClaim(uniqueId, bridged.matchedFileIds, accountId, chatId, {
          telegramFileId: doc.file_id,
          messageId,
          fileSize,
          fromRelayTarget,
          bridged: bridged.bridged,
        });
      } catch (error) {
        pool.bumpCounter('inboundRegistrationFailures');
        const text = error instanceof Error ? error.message : String(error);
        this.logger.warn(`入站副本登记失败（忽略，不影响直链签发）: ${text}`);
      }
    }

    // 归档转发与副本登记解耦：它是纯审计留痕，必须离开直链回复的关键路径
    // （forwardMessage 超时 30s，此前会让用户等满超时才收到链接）。
    void this.forwardArchiveCopy({ chatId, messageId, accountId });
  }

  /** 归档群转发（后台执行，失败只告警） */
  private async forwardArchiveCopy(input: {
    chatId: string;
    messageId: string;
    accountId?: string;
  }): Promise<void> {
    try {
      const archiveChatId = (this.configService?.get<string>('TELEGRAM_ARCHIVE_CHAT_ID') || '').trim();
      const pool = this.pool;
      const { chatId, messageId, accountId } = input;
      if (!archiveChatId || !pool || !accountId || !this.accountClient || !chatId || !messageId) return;
      if (chatId === archiveChatId) return; // 已在归档群，避免自转发循环

      // 来自「镜像群」或「主群」的消息只登记副本、不再归档转发：这两类群都是扩散落点，
      // 群内每条消息会被群内每个 Bot 各收到一次，逐个转发会让归档群消息量按 Bot 数（N）放大。
      if (await this.shouldSuppressArchiveForward(chatId)) {
        this.logger.debug(`来源为扩散落点（镜像群/主群，chat=${chatId}），跳过归档转发以避免 N 倍放大`);
        return;
      }
      const account = pool.getConfig(accountId);
      if (!account) return;
      const forwarded = await this.accountClient.forwardMessage(
        accountId,
        account.token,
        archiveChatId,
        chatId,
        messageId,
      );
      this.logger.log(`已用账号 ${accountId} 转发到归档群（审计留痕，messageId=${forwarded.messageId}）`);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.logger.warn(`转发到归档群失败（忽略）: ${text}`);
    }
  }

  /**
   * 是否应抑制向归档群转发（扩散落点 = 镜像群 ∪ 主群）。
   *
   * 为什么主群也要抑制：主群是副本扩散的中转落点，持有源消息的 Bot 会把消息转发进主群，
   * 群内每个 Bot 都会收到这条消息；若不抑制，归档群会按 Bot 数（N）被写满重复消息。
   *
   * 两段判定都各自兜底（读不到规则时分别返回 false / 沿用上次结果）：
   * 宁可多发一次归档转发，也不要因为规则暂时不可读而漏掉「副本可见性」这类真实可用性问题。
   */
  private async shouldSuppressArchiveForward(chatId: string): Promise<boolean> {
    return (await this.isMirrorTargetChat(chatId)) || (await this.isMainChat(chatId));
  }

  /** 判断某个 chat 是否是主群（任一规则的源群；读不到规则时返回 false） */
  private async isMainChat(chatId: string): Promise<boolean> {
    if (!this.mirrorConfig || !chatId) return false;
    try {
      const sources = await this.mirrorConfig.listSourceChatIds();
      return sources.includes(chatId);
    } catch (error) {
      this.logger.debug(
        `主群集合读取失败（按「非主群」处理）：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * 判断某个 chat 是否是镜像规则的「镜像群」（副本可见群）。
   *
   * 读不到规则时返回 false：宁可多发一次归档转发，也不要因为规则暂时不可读
   * 而漏掉「副本可见性」这类真实可用性问题。
   */
  private async isMirrorTargetChat(chatId: string): Promise<boolean> {
    if (!this.mirrorConfig) return false;
    try {
      const targets = await this.mirrorConfig.listTargetChatIds();
      return targets.includes(chatId);
    } catch (error) {
      this.logger.debug(
        `备份群集合读取失败（按「非备份群」处理）：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * 判断某个 chat 是否是**启用中**镜像规则的目标群（= 副本扩散的中继目标群）。
   *
   * 与 `isMirrorTargetChat` 的分工：
   * - 后者用于「是否抑制归档转发」，覆盖全部规则（含未启用）；
   * - 这里用于「这条消息是不是中继过来的」，**只认启用中的规则**——
   *   用未启用规则的目标群判定，会把普通备份群消息误标成 `relayed`，
   *   让后台把「非中继来源」统计成「中继已生效」。
   *
   * 读不到规则时返回 false（宁可漏标为 `inbound`，也不要误标）。
   */
  private async isEnabledMirrorTargetChat(chatId: string): Promise<boolean> {
    if (!this.mirrorConfig || !chatId) return false;
    try {
      const targets = await this.mirrorConfig.listEnabledTargetChatIds();
      return targets.includes(chatId);
    } catch (error) {
      this.logger.debug(
        `启用中备份群集合读取失败（按「非中继来源」处理）：`
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * 把 Bot 认领事件回写到扩散轮次，并为 grant 命名空间补齐副本归因。
   *
   * 为什么必须覆盖多个命名空间：轮次是按**发起扩散时的 owner** 建的（镜像任务用
   * `file:<站内 id>` 或 `grant:<授权 id>`），而认领天然只知道 `file_unique_id`。
   * 只写一个会让「中继成功」与「Bot 认领」在后台对不上，认领超时会被误判。
   * 现在覆盖三个命名空间：
   * - `fileUnique`：跨账号稳定的内容标识（始终回写）；
   * - `file`：桥接命中的站内逻辑文件（双写）；
   * - `grant`：Bot 私聊入站签发的授权记录——**只能靠 `file_unique_id` 归因**：
   *   镜像群里的消息只携带 `file_unique_id`，不含 grant 的私聊锚点
   *   `(telegramUserId, chatId, messageId)`，因此入站签发时已把 `file_unique_id`
   *   落库到 grant 上，此处用它反查（`findByFileUniqueId`）。
   *
   * 为什么必须带 `targetChatId`：**每条启用规则一个镜像群、各自一条活跃轮次**，
   * 同一文件在多个群同时中继时，不带目标群的认领会落到别的群的轮次上。
   *
   * 为什么 grant 归因仅在 `fromRelayTarget === true` 时执行：grant 轮次只对应
   * 「中继扩散」这一种来源。其它群里的普通文件消息若也回写 grant 命名空间，
   * 会把 grant 的副本计数抬高（后台把非扩散来源统计成扩散已生效），
   * 还会给不相关的 grant 凭空制造「认领」事件。
   *
   * 找不到匹配的进行中轮次时 `recordClaim` 内部静默返回（普通群消息本就没有对应轮次）。
   * 整段 best-effort：失败只记日志，不得回滚或影响副本登记与直链签发。
   */
  private async recordRelayClaim(
    uniqueId: string,
    matchedFileIds: string[],
    accountId: string,
    targetChatId?: string | null,
    grantAttribution?: GrantClaimAttribution,
  ): Promise<void> {
    const attempts = this.attempts;
    if (!attempts) return;
    try {
      await attempts.recordClaim('fileUnique', uniqueId, accountId, { targetChatId });
      for (const fileId of matchedFileIds) {
        await attempts.recordClaim('file', fileId, accountId, { targetChatId });
      }
    } catch (error) {
      // 观测写入失败**不得**回滚或污染业务写入（副本已登记成功），也不计入登记失败计数
      this.logger.debug(
        `认领回写失败（忽略，不影响副本登记）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // grant 命名空间归因（独立 best-effort）：失败不得影响上面的观测回写与副本登记。
    if (grantAttribution?.fromRelayTarget) {
      await this.attributeGrantClaims(uniqueId, accountId, targetChatId, grantAttribution);
    }
  }

  /**
   * grant 命名空间认领归因（`recordRelayClaim` 内部调用，best-effort）。
   *
   * 做法：用内容标识 `file_unique_id` 反查最近签发的 grant（≤5 条），对每条 grant
   * 写入本账号的副本行并回写「认领」事件——轮次结算（`readyAccountIds('grant', ...)`）
   * 依赖这两份数据，缺一即把「副本已产生」误判为 `claim_timeout`。
   *
   * 为什么必须靠 `file_unique_id`：群内消息不含 grant 的私聊锚点
   * `(telegramUserId, chatId, messageId)`，`file_unique_id` 是唯一的跨群归因键。
   *
   * 失败只记日志（与 `recordRelayClaim` 的失败语义一致），绝不影响副本登记与直链签发。
   */
  private async attributeGrantClaims(
    uniqueId: string,
    accountId: string,
    targetChatId: string | null | undefined,
    attribution: GrantClaimAttribution,
  ): Promise<void> {
    const copies = this.copies;
    const attempts = this.attempts;
    if (!copies || !attempts) return;
    try {
      const grants = await this.grantService.findByFileUniqueId(uniqueId);
      for (const grant of grants) {
        await copies.upsertReady({
          ownerType: 'grant',
          ownerId: grant.id,
          accountId,
          telegramFileId: attribution.telegramFileId,
          chatId: targetChatId ?? null,
          messageId: attribution.messageId,
          fileSize: attribution.fileSize,
          // 只有「中继来源 + 命中站内逻辑文件」才标注 relayed（与 fileUnique 行同一口径），
          // 避免把「中继来源但未桥接」统计成扩散已生效。
          source: attribution.fromRelayTarget && attribution.bridged ? 'relayed' : 'inbound',
        });
        await attempts.recordClaim('grant', grant.id, accountId, { targetChatId });
      }
    } catch (error) {
      this.logger.debug(
        `grant 命名空间认领归因失败（忽略，不影响副本登记）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleDocument(
    message: TelegramMessage,
    identity: TelegramBotIdentity,
    receiverBotId: string,
    accountId?: string,
  ): Promise<void> {
    const doc = message.document;
    if (!doc?.file_id) return;
    const chatId = String(message.chat.id);
    const messageId = String(message.message_id);
    const conversationKey = `${receiverBotId}:${chatId}`;
    const msgKey = `${conversationKey}:${messageId}`;
    if (this.activeTransfers.has(msgKey)) return;
    if (this.isShuttingDown) {
      await this.reply(chatId, '服务正在维护重启中，请稍后重新发送文件。', message.message_id, accountId);
      return;
    }

    const abortController = new AbortController();
    let drained!: () => void;
    const promise = new Promise<void>((resolve) => { drained = resolve; });
    this.activeTransfers.set(msgKey, { abortController, promise });
    const finish = () => {
      if (this.activeTransfers.get(msgKey)?.abortController === abortController) this.activeTransfers.delete(msgKey);
      drained();
    };
    let background: Promise<void> | undefined;
    try {
      const queueState = await this.inboundQueue.findByMessage(receiverBotId, chatId, messageId)
        .catch((error: unknown) => { throw new InboundPersistenceError(error); });
      if (queueState) return;

      if (await this.inboundQueue.isBanned(identity.telegramUserId)
        .catch((error: unknown) => { throw new InboundPersistenceError(error); })) {
        await this.reply(chatId, BANNED_TEXT, message.message_id, accountId);
        return;
      }
      const existing = await this.grantService.findByMessage(
        identity.telegramUserId, chatId, messageId, receiverBotId, doc.file_id,
      ).catch((error: unknown) => { throw new InboundPersistenceError(error); });
      if (existing) {
        const token = this.grantService.replayToken(existing);
        const origin = await this.botConfigService.resolveSiteOriginAsync();
        if (this.grantService.isActive(existing) && token && origin) {
          await this.reply(
            chatId,
            `该文件的下载链接：\n${this.grantService.buildUrl(origin, token)}\n（有效期至 ${new Date(existing.expiresAt).toISOString()}）`,
            message.message_id,
            accountId,
          );
        } else {
          await this.reply(
            chatId,
            '该文件的链接已失效（过期或已撤销），请重新发送文件以获取新链接。',
            message.message_id,
            accountId,
          );
        }
        return;
      }
      // 不设文件大小上限（含 `MAX_FILE_SIZE`）：
      // - Bot 文件不经过本站上传链路，`MAX_FILE_SIZE` 是「后台上传配置」的上传策略，与下载无关；
      // - 本地 Bot API 以 `--local` 运行时跳过 `MAX_DOWNLOAD_FILE_SIZE`（20MB）检查，
      //   流式端点 `--file-stream-max-size` 默认 0（不限制），因此可服务任意大小；
      // - 是否可播放/下载由客户端与磁盘决定，服务端不再提前拒绝。
      const fileSize = typeof doc.file_size === 'number' && doc.file_size > 0 ? doc.file_size : null;

      // 域名解析（fail-closed）：无可用可信域名时拒绝签发，且不消耗配额
      const config = await this.botConfigService.getConfig()
        .catch((error: unknown) => { throw new InboundPersistenceError(error); });
      const origin = await this.botConfigService.resolveSiteOriginAsync().catch((error: unknown) => {
        if (config.storageMode === 'gdrive') throw new InboundPersistenceError(error);
        throw error;
      });
      if (!origin) {
        await this.reply(
          chatId,
          '服务暂不可用：管理员尚未配置站点域名（直链域名）。请联系管理员在后台「Telegram Bot 设置」中配置。',
          message.message_id,
          accountId,
        );
        return;
      }

      const usageDate = this.quotaService.getBusinessDate(config.quotaTimezone);

      if (this.isShuttingDown) {
        await this.reply(chatId, '服务正在维护重启中，请稍后重新发送文件。', message.message_id, accountId);
        return;
      }
      // Google 缓存模式：签发时即写 pending（同一事务），避免"回复后、触发前崩溃 → 永不重试"
      const cacheMirrorEnabled = config.storageMode === 'telegram'
        && Boolean(this.storageRouter?.isGDriveCacheModeEnabled)
        && await this.storageRouter!.isGDriveCacheModeEnabled().catch(() => false);
      const grantInput: IssueGrantInput = {
        ...identity,
        chatId,
        messageId,
        telegramFileId: doc.file_id,
        sourceAccountId: accountId ?? receiverBotId,
        receiverBotId,
        fileName: this.sanitizePlain(doc.file_name, 255),
        mimeType: this.sanitizePlain(doc.mime_type, 128),
        fileSize: fileSize === null ? null : String(fileSize),
        fileUniqueId: doc.file_unique_id ?? null,
        ...(cacheMirrorEnabled ? { gdriveCacheStatus: 'pending' as const, gdriveCacheNextRetryAt: new Date() } : {}),
      };
      if (config.storageMode === 'gdrive') {
        const { username, displayName, ...fields } = grantInput;
        const result = await this.inboundQueue.enqueue({
          ...fields,
          sourceAccountId: accountId ?? null,
          fileUniqueId: fields.fileUniqueId ?? null,
          telegramUsername: username,
          telegramDisplayName: displayName,
          usageDate,
          dailyLimit: config.dailyLimit,
        }, (manager, task) => this.auditService.logInTransaction(manager, {
          action: 'telegram_bot_file_received',
          resourceType: 'telegram_bot_file',
          resourceId: task.id,
          metadata: {
            telegramUserId: task.telegramUserId,
            telegramUsername: task.telegramUsername,
            chatId: task.chatId,
            chatType: 'private',
            messageId: task.messageId,
            fileName: task.fileName,
            fileSize,
            mimeType: task.mimeType,
            viaWhitelist: !task.quotaConsumed,
          },
        })).catch((error: unknown) => { throw new InboundPersistenceError(error); });
        if (result.status === 'queued') {
          this.pollQueue();
        } else if (result.status === 'banned') {
          await this.reply(chatId, BANNED_TEXT, message.message_id, accountId);
        } else if (result.status === 'quota_denied') {
          await this.replyQuotaDenied(identity, usageDate, result.used, config.dailyLimit, chatId, message.message_id, accountId);
        }
        return;
      }

      await this.registerInboundCopyAndForward(message, accountId);
      await this.auditDocumentReceived(identity, message, fileSize);
      const whitelisted = await this.quotaService.isWhitelisted(identity.telegramUserId);
      let quotaConsumed = false;
      let quotaUsed = 0;
      if (!whitelisted) {
        const quota = await this.quotaService.consume(identity.telegramUserId, usageDate, config.dailyLimit);
        if (!quota.allowed) {
          await this.replyQuotaDenied(identity, usageDate, quota.used, config.dailyLimit, chatId, message.message_id, accountId);
          return;
        }
        quotaConsumed = true;
        quotaUsed = quota.used;
      } else {
        quotaUsed = await this.quotaService.getUsed(identity.telegramUserId, usageDate);
      }

      try {
        const issued = await this.inboundQueue.withUnbannedUser(identity.telegramUserId, (manager) =>
          this.grantService.issue(grantInput, config.linkTtlHours, manager),
        );
        if (!issued) {
          if (quotaConsumed) await this.quotaService.refund(identity.telegramUserId, usageDate);
          await this.reply(chatId, BANNED_TEXT, message.message_id, accountId);
          return;
        }
        const { grant, token } = issued;

        // grant 命名空间主副本行（best-effort）：轮次结算按 `grant:<id>` 查 ready 副本，
        // 源账号收到文件时先写基线行，否则「副本已产生但轮次结算为 claim_timeout」；
        // 失败只记日志，绝不影响直链签发（与镜像触发同属增强路径）。
        await this.upsertGrantBaselineCopy(grant, message, fileSize, accountId);

        const url = this.grantService.buildUrl(origin, token);
        const fileName = doc.file_name || '(未命名)';

        this.auditService.log({
          action: 'telegram_bot_link_issued',
          resourceType: 'telegram_bot_grant',
          resourceId: grant.id,
          metadata: {
            telegramUserId: identity.telegramUserId,
            telegramUsername: identity.username,
            grantId: grant.id,
            tokenPrefix: grant.tokenPrefix,
            expiresAt: grant.expiresAt,
            quotaDate: usageDate,
            quotaUsed,
            viaWhitelist: whitelisted,
            domainMode: config.linkDomainMode,
            sourceAccountId: grant.sourceAccountId,
            fileName,
          },
        });

        await this.reply(
          chatId,
          {
            ...renderLinkReady({
              fileName,
              url,
              expiresAt: new Date(grant.expiresAt).toISOString(),
              ttlHours: config.linkTtlHours,
            }),
            messageEffectId: this.messageEffectId(),
          },
          message.message_id,
          accountId,
        );

        // 镜像备份（Bot 入站）：grant 已持久化后才触发；镜像失败不回滚签发与配额
        void this.triggerInboundMirror(grant, accountId);
        if (cacheMirrorEnabled) {
          background = this.mirrorGrantToGDriveCache(grant, abortController.signal);
        }
      } catch (error) {
        // 签发失败：归还已消耗的配额，避免用户白白损失额度
        if (quotaConsumed) {
          await this.quotaService.refund(identity.telegramUserId, usageDate);
        }
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error(`直链签发失败: ${detail}`);
        await this.reply(chatId, '内部错误：生成下载链接失败，请稍后重试。', message.message_id, accountId);
      }
    } finally {
      if (background) {
        void background.then(finish, (err: unknown) => {
          this.logger.error(`后台转存失败: ${err instanceof Error ? err.message : String(err)}`);
          finish();
        });
      } else {
        finish();
      }
    }
  }

  private async replyQuotaDenied(
    identity: TelegramBotIdentity, usageDate: string, used: number, limit: number,
    chatId: string, messageId: number, accountId?: string,
  ): Promise<void> {
    this.auditService.log({
      action: 'telegram_bot_quota_denied',
      resourceType: 'telegram_bot_quota',
      resourceId: identity.telegramUserId,
      status: AuditStatus.FAILURE,
      metadata: {
        telegramUserId: identity.telegramUserId,
        telegramUsername: identity.username,
        quotaDate: usageDate,
        quotaUsed: used,
        quotaLimit: limit,
      },
    });
    await this.reply(chatId, renderQuotaDenied(limit), messageId, accountId);
  }

  /**
   * grant 命名空间主副本行（best-effort，Bot 私聊入站签发成功后调用）。
   *
   * 为什么需要：轮次结算（`ReplicationClaimSweeperService`）按
   * `readyAccountIds('grant', grantId)` 判定「副本已产生」；源账号自己收到文件时
   * 若不在 grant 命名空间登记，轮次就没有基线，「副本已产生但轮次结算为
   * claim_timeout」会永远复现。
   *
   * 可用性判定与 `registerInboundCopyAndForward` 保持一致（账号 + 池化 + 副本服务
   * 三者齐备才登记）；账号缺失（单账号模式）跳过并记 debug。缺 `file_unique_id`
   * 的降级路径不登记：该 grant 无法被群内认领归因（`findByFileUniqueId` 查不到），
   * 主副本行没有结算意义，也不应把「不参与扩散的文件」计入副本统计。
   *
   * 失败只记 warn：副本登记属增强链路，**绝不影响直链签发**（签发已成功落库）。
   */
  private async upsertGrantBaselineCopy(
    grant: TelegramBotFileGrant,
    message: TelegramMessage,
    fileSize: number | null,
    accountId?: string,
  ): Promise<void> {
    if (!accountId) {
      this.logger.debug(`未携带账号上下文，跳过 grant 主副本登记（grant=${grant.id}）`);
      return;
    }
    const pool = this.pool;
    const copies = this.copies;
    if (!pool?.isActive() || !copies) return;
    const doc = message.document;
    if (!doc?.file_id || !doc.file_unique_id) return;
    try {
      await copies.upsertReady({
        ownerType: 'grant',
        ownerId: grant.id,
        accountId,
        telegramFileId: doc.file_id,
        chatId: String(message.chat.id),
        messageId: String(message.message_id),
        fileSize,
        source: 'inbound',
      });
    } catch (error) {
      this.logger.warn(
        `grant 主副本登记失败（不影响直链签发）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Bot 私聊入站文件的镜像触发（fire-and-forget）。
   *
   * 归属对象用 `grant`：它同时持有 `file_id`、源 `chat_id + message_id`、文件名与大小，
   * 是用户账号无源复制所需的全部定位信息；`sourceAccountId` 是回退安全锚点
   * （池化模式下必须用收到文件的账号自己的 file_id 取源）。
   */
  private async triggerInboundMirror(grant: TelegramBotFileGrant, accountId?: string): Promise<void> {
    if (!this.mirrorTrigger) return;
    try {
      await this.mirrorTrigger.onFileCommitted(
        {
          ownerType: 'grant',
          ownerId: grant.id,
          // Bot 入站文件没有覆盖上传语义，版本固定为 1（幂等键稳定）
          sourceVersion: 1,
          sourceAccountId: grant.sourceAccountId ?? accountId ?? null,
          sourceChatId: grant.chatId ? String(grant.chatId) : null,
          sourceMessageId: grant.messageId ? String(grant.messageId) : null,
        },
        'bot_inbound',
      );
    } catch (error) {
      this.logger.warn(
        `入站镜像触发失败（不影响直链签发）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async auditDocumentReceived(
    identity: TelegramBotIdentity,
    message: TelegramMessage,
    fileSize: number | null,
  ): Promise<void> {
    const doc = message.document;
    if (!doc) return;
    const whitelisted = await this.quotaService.isWhitelisted(identity.telegramUserId);
    this.auditService.log({
      action: 'telegram_bot_file_received',
      resourceType: 'telegram_bot_file',
      metadata: {
        telegramUserId: identity.telegramUserId,
        telegramUsername: identity.username,
        chatId: String(message.chat.id),
        chatType: message.chat.type,
        messageId: String(message.message_id),
        fileName: this.sanitizePlain(doc.file_name, 255),
        fileSize,
        mimeType: this.sanitizePlain(doc.mime_type, 128),
        viaWhitelist: whitelisted,
      },
    });
  }

  private sanitizePlain(value: string | undefined, maxLength: number): string | null {
    if (!value) return null;
    const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
    return cleaned ? cleaned.slice(0, maxLength) : null;
  }

  /**
   * 单账号模式下的源账号标识：默认 Bot Token 的数字前缀（botId）。
   *
   * 写入它的意义：若日后启用账号池，这些历史 Grant 的 `file_id` 归属仍可确认，
   * 从而可以「只用源账号回源」，避免跨账号错用；无法解析（未配置/占位符）时返回 null，
   * 回退链路会按「归属不明」fail-closed 处理。
   */
  private defaultSourceAccountId(): string | null {
    const token = (this.configService?.get<string>('TELEGRAM_BOT_TOKEN') || '').trim();
    const botId = token.split(':')[0]?.trim();
    return botId && /^\d+$/.test(botId) ? botId : null;
  }

  private buildHelpText(identity?: TelegramBotIdentity): RenderedMessage {
    const admin = identity ? this.adminService.isAdmin(identity.telegramUserId) : false;
    return renderHelp({ admin });
  }

  private pollQueue(): void {
    if (this.isShuttingDown) return;
    const accounts = new Map<string, string | undefined>();
    if (this.pool?.isActive()) {
      for (const accountId of this.pool.ids()) {
        const botId = this.pool.getConfig(accountId)?.token.split(':')[0];
        if (botId && /^\d+$/.test(botId)) accounts.set(botId, accountId);
      }
    } else {
      const botId = this.defaultSourceAccountId();
      if (botId) accounts.set(botId, undefined);
    }

    const now = Date.now();
    for (const [botId, accountId] of accounts) {
      if ((this.telegramCooldownUntil.get(botId) ?? 0) > now) continue;
      if ((this.nextNoticeAt.get(botId) ?? 0) <= now) {
        this.startQueueWorker(this.noticeWorkers, botId, () => this.deliverQueueNotice(botId, accountId));
      }
      this.startQueueWorker(this.queueWorkers, botId, () => this.processQueuedFile(botId, accountId));
    }
  }

  private startQueueWorker(workers: Map<string, Promise<void>>, botId: string, run: () => Promise<void>): void {
    if (workers.has(botId)) return;
    const pending = run().catch((error: unknown) => {
      this.logger.error(`Bot ${botId} 队列处理失败: ${redactBotToken(error instanceof Error ? error.message : String(error))}`);
    }).finally(() => { workers.delete(botId); });
    workers.set(botId, pending);
  }

  private async processQueuedFile(botId: string, accountId?: string): Promise<void> {
    const task = await this.inboundQueue.claimNext(botId);
    if (!task) return;
    if (this.isShuttingDown) {
      await this.inboundQueue.release(task);
      return;
    }
    const controller = new AbortController();
    const conversationKey = `${botId}:${task.chatId}`;
    const taskKey = `${conversationKey}:${task.messageId}`;
    this.incrementChatActiveTransfer(conversationKey);
    const pending = this.executeGDriveTransfer(task, controller, accountId).finally(() => {
      this.decrementChatActiveTransfer(conversationKey);
      if (this.activeTransfers.get(taskKey)?.abortController === controller) this.activeTransfers.delete(taskKey);
    });
    this.activeTransfers.set(taskKey, { abortController: controller, promise: pending });
    await pending;
  }

  private async deliverQueueNotice(botId: string, accountId?: string): Promise<void> {
    const notice = await this.inboundQueue.nextNotice(botId);
    if (!notice) return;
    if (this.isShuttingDown) {
      await this.inboundQueue.deferNotice(notice, 0);
      return;
    }
    const { task, position } = notice;
    let messageId: number | null;
    try {
      const text = await this.queueNoticeText(task, position);
      this.nextNoticeAt.set(botId, Date.now() + NOTICE_INTERVAL_MS);
      messageId = await this.sendQueueNotice(task, text, accountId);
    } catch (error) {
      const wait = telegramBackoffMs(error);
      if (wait) this.telegramCooldownUntil.set(botId, Date.now() + wait);
      const status = error instanceof TelegramAccountError ? error.status : (error as { response?: { status?: number } })?.response?.status;
      if (status === 403 || /bot was blocked|chat not found|user is deactivated/i.test((error as Error)?.message ?? '')) {
        await this.inboundQueue.markNotice(notice, task.waitingMsgId);
      } else {
        await this.inboundQueue.deferNotice(notice, wait ?? NOTICE_RETRY_MS, Boolean(wait));
      }
      return;
    }
    await this.inboundQueue.markNotice(notice, messageId);
  }

  private async queueNoticeText(task: TelegramBotInboundTask, position: number): Promise<RenderedMessage> {
    const fileName = task.fileName ?? '(未命名)';
    const cancelCallbackData = task.status === 'queued' || task.status === 'running' ? `bot_cancel:${task.id}` : undefined;
    if (task.status === 'queued') {
      return renderQueueNotice({ status: 'queued', position, fileName, cancelCallbackData });
    }
    if (task.status === 'running') {
      return renderQueueNotice({ status: 'running', fileName, cancelCallbackData });
    }
    if (task.status === 'cancelled') return renderQueueNotice({ status: 'cancelled', fileName });
    if (task.status === 'failed') {
      return renderQueueNotice({
        status: 'failed',
        fileName,
        failureReason: task.failureReason === 'disk_unavailable' ? 'disk_unavailable' : null,
      });
    }

    const grant = task.grantId ? await this.grantService.findById(task.grantId) : null;
    if (!grant || !this.grantService.isActive(grant)) return renderQueueNotice({ status: 'expired', fileName });
    const token = this.grantService.tokenForQueuedNotice(grant, task.id);
    const origin = await this.botConfigService.resolveSiteOriginAsync();
    if (!origin) throw new Error('站点域名暂不可用，稍后重试发送直链');
    if (!token) return renderQueueNotice({ status: 'unrecoverable', fileName });
    const url = this.grantService.buildUrl(origin, token);
    const expiry = new Date(grant.expiresAt).toISOString();
    return {
      ...renderQueueNotice({ status: 'ready', fileName, url, expiresAt: expiry }),
      messageEffectId: this.messageEffectId(),
    };
  }

  private async sendQueueNotice(task: TelegramBotInboundTask, text: string | RenderedMessage, accountId?: string): Promise<number | null> {
    const account = accountId && this.pool?.getConfig(accountId);
    if (accountId && (!account || !this.accountClient || account.token.split(':')[0] !== task.receiverBotId)) {
      throw new Error('接收 Bot 的账号配置暂不可用');
    }
    if (!accountId && this.defaultSourceAccountId() !== task.receiverBotId) {
      throw new Error('默认 Bot 已变更，无法发送收件通知');
    }
    const rendered: RenderedMessage = typeof text === 'string' ? { text } : text;
    // edit 与 send 必须使用同一份降级决策，否则编辑后格式会丢失
    const send = (payload: string, options: TelegramTextSendOptions) => (account && this.accountClient
      ? this.accountClient
        .sendMessage(account.id, account.token, task.chatId, payload, { ...options, replyToMessageId: Number(task.messageId) })
        .then(sent => sent.messageId ?? null)
      : this.telegramService
        .sendMessage(task.chatId, payload, { ...options, replyToMessageId: Number(task.messageId), deferRateLimit: true })
        .then(sent => sent.message_id ?? null));
    const edit = (payload: string, options: TelegramTextSendOptions) => (account && this.accountClient
      ? this.accountClient.editMessageText(account.id, account.token, task.chatId, task.waitingMsgId!, payload, options)
      : this.telegramService.editMessageText(task.chatId, task.waitingMsgId!, payload, { ...options, deferRateLimit: true }));

    const existingId = task.waitingMsgId;
    if (existingId) {
      try {
        const edited = await this.deliverRendered(rendered, (payload, options) => edit(payload, options).then(ok => (ok ? existingId : null)));
        if (edited) return edited;
      } catch (error) {
        const message = (error as Error)?.message ?? '';
        if (/message is not modified/i.test(message)) return existingId;
        if (!/message to edit not found|message can.t be edited/i.test(message)) throw error;
      }
    }
    return this.deliverRendered(rendered, send);
  }

  private incrementChatActiveTransfer(conversationKey: string): void {
    const current = this.activeTransfersByChat.get(conversationKey) ?? 0;
    this.activeTransfersByChat.set(conversationKey, current + 1);
  }

  private decrementChatActiveTransfer(conversationKey: string): void {
    const current = this.activeTransfersByChat.get(conversationKey) ?? 0;
    if (current <= 1) {
      this.activeTransfersByChat.delete(conversationKey);
      this.chatNoticeCooldowns.delete(conversationKey);
    } else {
      this.activeTransfersByChat.set(conversationKey, current - 1);
    }
  }

  private hasActiveTransferForChat(conversationKey: string): boolean {
    return (this.activeTransfersByChat.get(conversationKey) ?? 0) > 0;
  }

  private async handleInFlightChatNotice(
    conversationKey: string,
    chatId: string,
    replyToMessageId: number,
    accountId?: string,
  ): Promise<void> {
    const now = Date.now();
    const lastNoticeAt = this.chatNoticeCooldowns.get(conversationKey);
    if (lastNoticeAt !== undefined && now - lastNoticeAt < this.inFlightNoticeCooldownMs) {
      this.logger.debug(`私聊 ${chatId} 处于在途转存提示冷却中，静默丢弃多余发言回复`);
      return;
    }
    this.chatNoticeCooldowns.set(conversationKey, now);
    await this.reply(
      chatId,
      '⏳ 您的文件正在创建直链中，请耐心等待完成通知，无需重复发送消息。',
      replyToMessageId,
      accountId,
    );
  }

  /**
   * 纯 Google 存储模式后台异步转存管线。
   */
  private async executeGDriveTransfer(
    task: TelegramBotInboundTask,
    controller: AbortController,
    accountId?: string,
  ): Promise<void> {
    const { signal } = controller;
    const reportedSize = Number(task.fileSize);
    const fileSize = Number.isSafeInteger(reportedSize) && reportedSize > 0 ? reportedSize : undefined;
    let renewing: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewing || signal.aborted) return;
      renewing = this.inboundQueue.renew(task).then((owned) => {
        if (!owned) controller.abort();
      }).catch(() => { controller.abort(); }).finally(() => { renewing = undefined; });
    }, LEASE_RENEWAL_MS);
    heartbeat.unref();
    let tempFilePath: string | undefined;
    let releaseTransferLease: (() => void) | undefined;
    let uploadReceipt: StorageUploadReceipt | null = null;
    let diskReservation: DownloadReservation | null = null;
    let uploadSessionId: string | null = null;
    let upstreamLease: DownloadUpstreamLease | null = null;

    try {
      signal.throwIfAborted();
      const config = await this.botConfigService.getConfig();
      if (!this.storageRouter?.availableBackendTypes().includes('gdrive')) {
        throw new Error('Google 云端硬盘存储池暂不可用');
      }

      const estimatedBytes = fileSize ?? 50 * 1024 * 1024;
      // 后台转存属于"用户不可见"的批处理：必须进入全局上行预算，
      // 否则大批收件会与前台下载抢同一个 Bot 账号的出口带宽。
      upstreamLease = this.downloadResources?.acquireUpstreamSlot
        ? await this.downloadResources.acquireUpstreamSlot({ bytes: estimatedBytes, waitTimeoutMs: 60_000, signal })
        : null;
      if (this.uploadDiskBudget?.isStrictMode()) {
        const sessionId = randomUUID();
        await this.uploadDiskBudget.acquireSession(sessionId, estimatedBytes);
        uploadSessionId = sessionId;
      }

      signal.throwIfAborted();
      const configuredBotId = accountId ? this.pool?.getConfig(accountId)?.token.split(':')[0] : this.defaultSourceAccountId();
      if (configuredBotId !== task.receiverBotId) {
        throw new Error('Bot 来源账号已变更，无法安全回源');
      }

      const streamLargeFile = fileSize !== undefined && fileSize > GDRIVE_MULTIPART_MAX_BYTES;
      let source: Pick<StorageUploadParams, 'openStream' | 'knownLength' | 'chunkSize'>;
      if (streamLargeFile) {
        const chunkSize = await this.storageRouter.getGDriveChunkSizeBytes();
        source = {
          knownLength: fileSize,
          chunkSize,
          openStream: () => this.openGDriveTransferSource(task.telegramFileId, fileSize, accountId, chunkSize, signal),
        };
      } else {
        const tempDir = path.join(process.cwd(), 'tmp', 'bot-transfers');
        const stagedPath = path.join(tempDir, `${randomUUID()}.tmp`);
        tempFilePath = stagedPath;
        releaseTransferLease = this.transferTracker?.register(stagedPath);
        await mkdir(tempDir, { recursive: true });
        if (this.downloadResources) {
          try {
            diskReservation = await this.downloadResources.reserve({
              sessionKey: `bot-transfer:${task.id}`,
              bytes: estimatedBytes,
              countsTowardCache: false,
              waitTimeoutMs: 30_000,
              signal,
            });
          } catch (error) {
            signal.throwIfAborted();
            this.logger.warn(`本地磁盘预约不足，拒绝 Bot 转存任务: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(DISK_UNAVAILABLE_TEXT);
          }
        }
        const upstreamStream = await this.getTelegramSourceStream(task.telegramFileId, fileSize, accountId, signal);
        await this.writeTransferFile(upstreamStream, stagedPath, diskReservation, signal);
        source = {
          knownLength: (await stat(stagedPath)).size,
          openStream: () => createReadStream(stagedPath, { highWaterMark: 1024 * 1024 }),
        };
      }

      signal.throwIfAborted();
      const size = source.knownLength;
      const receipt = await this.storageRouter.upload({
        ...source,
        backendType: 'gdrive',
        objectName: task.fileName ?? `tg_${task.telegramFileId}`,
        mimeType: task.mimeType ?? undefined,
        signal,
      });
      uploadReceipt = receipt;
      if (streamLargeFile && receipt.size !== size) {
        throw new Error('Google 云端硬盘返回的文件大小与 Telegram 源不一致');
      }
      signal.throwIfAborted();

      const issued = await this.inboundQueue.complete(task, async (manager) => {
        const result = await this.grantService.issue({
          telegramUserId: task.telegramUserId,
          username: task.telegramUsername,
          displayName: task.telegramDisplayName,
          chatId: task.chatId,
          messageId: task.messageId,
          telegramFileId: task.telegramFileId,
          sourceAccountId: accountId ?? task.receiverBotId,
          receiverBotId: task.receiverBotId,
          fileName: task.fileName,
          mimeType: task.mimeType,
          fileSize: String(size),
          fileUniqueId: task.fileUniqueId,
          storageBackend: 'gdrive',
          storageAccountId: receipt.accountId,
          storageObjectRef: receipt.objectRef,
        }, config.linkTtlHours, manager, task.id);
        await this.auditService.logInTransaction(manager, {
          action: 'telegram_bot_link_issued',
          resourceType: 'telegram_bot_grant',
          resourceId: result.grant.id,
          metadata: {
            telegramUserId: task.telegramUserId,
            telegramUsername: task.telegramUsername,
            grantId: result.grant.id,
            tokenPrefix: result.grant.tokenPrefix,
            expiresAt: result.grant.expiresAt,
            quotaDate: task.usageDate,
            quotaUsed: task.quotaUsed,
            viaWhitelist: !task.quotaConsumed,
            domainMode: config.linkDomainMode,
            sourceAccountId: result.grant.sourceAccountId,
            storageBackend: 'gdrive',
            fileName: task.fileName,
          },
        });
        return result;
      });
      if (!issued) return;
      // 事务提交后，上传对象归授权记录所有。通知失败时由通知队列重试。
      uploadReceipt = null;
      if (accountId && this.pool?.getConfig(accountId)?.token.split(':')[0] === task.receiverBotId) {
        await this.registerInboundCopyAndForward({
          chat: { id: Number(task.chatId), type: 'private' },
          message_id: Number(task.messageId),
          document: { file_id: task.telegramFileId, file_unique_id: task.fileUniqueId ?? undefined, file_size: size },
        }, accountId).catch(() => { this.logger.warn(`Bot 收件任务 ${task.id} 的副本登记或归档失败`); });
      }
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof DownloadResourceException) {
          await this.inboundQueue.retry(task, error.retryAfterMs ?? 30_000);
          return;
        }
        const wait = telegramBackoffMs(error);
        if (wait) {
          this.telegramCooldownUntil.set(task.receiverBotId, Date.now() + wait);
          await this.inboundQueue.retry(task, wait);
        } else {
          const detail = error instanceof Error ? error.message : String(error);
          this.logger.error(`Bot 转存失败: ${redactBotToken(detail)}`);
          await this.inboundQueue.fail(task, detail === DISK_UNAVAILABLE_TEXT ? 'disk_unavailable' : 'transfer_failed');
        }
      }
    } finally {
      clearInterval(heartbeat);
      releaseTransferLease?.();
      if (tempFilePath) await unlink(tempFilePath).catch(() => {});
      diskReservation?.release();
      upstreamLease?.release();
      if (uploadSessionId) this.uploadDiskBudget?.releaseSession(uploadSessionId);
      if (uploadReceipt?.accountId && uploadReceipt.objectRef && this.storageRouter) {
        const { accountId: uploadedAccountId, objectRef } = uploadReceipt;
        // 若数据库在提交确认时断开，先核对授权拥有权再删除对象，避免已签发链接丢失文件。
        try {
          const recorded = await this.grantService.findByMessage(
            task.telegramUserId, task.chatId, task.messageId, task.receiverBotId, task.telegramFileId,
          );
          if (recorded?.storageObjectRef !== objectRef || recorded.storageAccountId !== uploadedAccountId) {
            await this.storageRouter.deleteRemoteObject('gdrive', uploadedAccountId, objectRef);
          }
        } catch {
          this.logger.error(`Bot 转存任务 ${task.id} 的远端对象清理失败`);
        }
      }
      await this.inboundQueue.release(task);
    }
  }

  private openGDriveTransferSource(
    fileId: string,
    size: number,
    accountId: string | undefined,
    chunkSize: number,
    signal: AbortSignal,
  ): Readable {
    return this.openBufferedTransferSource(
      size,
      chunkSize,
      signal,
      (upstreamSignal) => this.getTelegramSourceStream(fileId, size, accountId, upstreamSignal),
    );
  }

  /** 后台镜像取源：同样走缓冲封装，但每次开流都重新过一遍账号池选号 */
  private openMirrorTransferSource(
    grant: TelegramBotFileGrant,
    size: number,
    chunkSize: number,
    signal: AbortSignal,
  ): Readable {
    return this.openBufferedTransferSource(
      size,
      chunkSize,
      signal,
      (upstreamSignal) => this.openMirrorSourceStream(grant, size, upstreamSignal),
    );
  }

  private openBufferedTransferSource(
    size: number,
    chunkSize: number,
    signal: AbortSignal,
    openUpstream: (signal: AbortSignal) => Promise<Readable>,
  ): Readable {
    // Google 等待当前分块确认时，提前读取下一块；缓冲写满后让 Telegram 流背压。
    const buffered = new PassThrough({ readableHighWaterMark: chunkSize, writableHighWaterMark: 64 * 1024 });
    void pipeline(
      (options?: { signal?: AbortSignal }) =>
        this.readTelegramTransfer(openUpstream, size, options?.signal ?? signal),
      buffered,
      { signal },
    ).catch(() => {
      // pipeline 已销毁 buffered，读取方会收到同一错误。
    });
    return buffered;
  }

  /**
   * 后台镜像取源：多 Bot 账号池「严格空闲优先」+ 普通加权 + 源账号 fail-closed 三级回退。
   *
   * 为什么不能直接用 `grant.sourceAccountId`：镜像与前台下载共用同一个源账号时，
   * 大文件会把该账号的出口带宽占满。跨账号复用 `file_id` 是不允许的（按账号隔离），
   * 所以「换账号」只能换成**持有该文件 ready 副本**的账号，每账号用自己的 file_id ——
   * 这正是 `openStream` 的语义，因此这里复用而不是新造取流原语。
   */
  private async openMirrorSourceStream(
    grant: TelegramBotFileGrant,
    expectedSize: number | undefined,
    signal: AbortSignal,
  ): Promise<Readable> {
    const pool = this.accountPoolDownload;
    const fileUniqueId = (grant.fileUniqueId || '').trim();
    if (pool?.isActive() && this.copies && fileUniqueId) {
      const attempts = [
        { idleOnly: true, counter: 'idlePreferred' as const },
        { idleOnly: false, counter: 'idleFallback' as const },
      ];
      for (const attempt of attempts) {
        const opened = await pool.openStream({
          ownerType: 'fileUnique',
          ownerId: fileUniqueId,
          expectedSize,
          noCache: true,
          idleOnly: attempt.idleOnly,
          fileName: grant.fileName || 'download',
          signal,
        }).catch((error: unknown) => {
          this.logger.warn(
            `镜像取源选号异常（grant=${grant.id}，idleOnly=${attempt.idleOnly}）：`
            + `${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        });
        if (opened) {
          pool.bumpCounter(attempt.counter);
          return opened.stream;
        }
      }
    }

    return this.getTelegramSourceStream(
      grant.telegramFileId,
      expectedSize,
      grant.sourceAccountId ?? undefined,
      signal,
    );
  }

  private async *readTelegramTransfer(
    openUpstream: (signal: AbortSignal) => Promise<Readable>,
    size: number,
    signal: AbortSignal,
  ): AsyncGenerator<Buffer> {
    try {
      const stream = await openUpstream(signal);
      let received = 0;
      let tail: Buffer | undefined;
      for await (const chunk of stream) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!data.length) continue;
        received += data.length;
        if (received > size) throw new Error('Telegram 源流超出预期文件大小');
        // 尾部等源流正常结束才交给 Google，避免远端先于完整性检查提交对象。
        if (received === size) tail = data;
        else yield data;
      }
      if (!tail) throw new Error('Telegram 源流提前结束');
      yield tail;
    } catch (error) {
      throw new StorageUploadSourceError(error);
    }
  }

  /**
   * 将 Bot 直链对应的 Telegram 副本镜像到 Google（带状态机与退避重试）。
   *
   * 数据源一律取自 grant 行，首次触发与扫描重试共用同一实现：
   * - 大文件流式直传，小文件落盘后上传，两条路径都做字节数校验；
   * - 进入全局上行并发预算，避免与前台下载抢同一个 Bot 账号的出口带宽；
   * - 失败写 `failed` + 退避时间，交给扫描任务重试，绝不影响已发出的直链。
   */
  private async mirrorGrantToGDriveCache(grant: TelegramBotFileGrant, signal?: AbortSignal): Promise<void> {
    if (!this.storageRouter || this.isShuttingDown) return;
    // 进程内互斥：首投与重试扫描可能同时命中同一 grant
    if (this.cacheMirrorInflight.has(grant.id)) return;
    this.cacheMirrorInflight.add(grant.id);
    let leaseTimer: NodeJS.Timeout | null = null;
    try {
      await this.runGrantGDriveCacheMirror(grant, signal, (timer) => { leaseTimer = timer; });
    } finally {
      if (leaseTimer) clearInterval(leaseTimer);
      this.cacheMirrorInflight.delete(grant.id);
    }
  }

  /** 上传期间续期，避免长传输被重试扫描重复领取（行级 lease 只有 10 分钟） */
  private startGrantLeaseRenewal(grantId: string): NodeJS.Timeout {
    const timer = setInterval(() => {
      void this.grantService.renewGDriveCacheLease(grantId).catch(() => undefined);
    }, Math.max(30_000, Math.floor(GDRIVE_CACHE_LEASE_MS / 2)));
    timer.unref?.();
    return timer;
  }

  private async runGrantGDriveCacheMirror(
    grant: TelegramBotFileGrant,
    signal: AbortSignal | undefined,
    onLeaseTimer: (timer: NodeJS.Timeout) => void,
  ): Promise<void> {
    const config = await this.botConfigService.getConfig().catch(() => null);
    if (!config || config.storageMode !== 'telegram') return;
    const storageRouter = this.storageRouter;
    if (!storageRouter) return;
    if (!(await storageRouter.isGDriveCacheModeEnabled().catch(() => false))) return;
    if (!(await this.grantService.markGDriveCachePending(grant.id).catch(() => false))) return;
    onLeaseTimer(this.startGrantLeaseRenewal(grant.id));

    const mirrorSignal = signal ?? new AbortController().signal;
    const reported = Number(grant.fileSize);
    const knownSize = Number.isSafeInteger(reported) && reported > 0 ? reported : undefined;
    const estimatedBytes = knownSize ?? 50 * 1024 * 1024;
    let uploadSessionId: string | null = null;
    let tempFilePath: string | null = null;
    let releaseTransferLease: (() => void) | undefined;
    let diskReservation: DownloadReservation | null = null;
    let upstreamLease: DownloadUpstreamLease | null = null;
    let uploadedReceipt: StorageUploadReceipt | null = null;

    try {
      upstreamLease = this.downloadResources?.acquireUpstreamSlot
        ? await this.downloadResources.acquireUpstreamSlot({
          bytes: estimatedBytes,
          waitTimeoutMs: 60_000,
          signal: mirrorSignal,
        })
        : null;

      if (this.uploadDiskBudget?.isStrictMode()) {
        const sessionId = randomUUID();
        await this.uploadDiskBudget.acquireSession(sessionId, estimatedBytes);
        uploadSessionId = sessionId;
      }

      const streamLargeFile = knownSize !== undefined && knownSize > GDRIVE_MULTIPART_MAX_BYTES;
      let receipt: StorageUploadReceipt;
      if (streamLargeFile) {
        const chunkSize = await this.storageRouter.getGDriveChunkSizeBytes();
        receipt = await this.storageRouter.upload({
          backendType: 'gdrive',
          objectName: grant.fileName ?? `tg_${grant.telegramFileId}`,
          mimeType: grant.mimeType ?? undefined,
          knownLength: knownSize,
          chunkSize,
          signal: mirrorSignal,
          openStream: () => this.openMirrorTransferSource(grant, knownSize, chunkSize, mirrorSignal),
        });
        if (receipt.size !== knownSize) {
          throw new Error('Google 返回的文件大小与 Telegram 源不一致');
        }
      } else {
        const tempDir = path.join(process.cwd(), 'tmp', 'bot-transfers');
        await mkdir(tempDir, { recursive: true });
        const localTempPath = path.join(tempDir, `gdrive_cache_${randomUUID()}.tmp`);
        tempFilePath = localTempPath;
        releaseTransferLease = this.transferTracker?.register(localTempPath);

        if (this.downloadResources) {
          diskReservation = await this.downloadResources.reserve({
            sessionKey: `bot-cache-mirror:${grant.id}`,
            bytes: estimatedBytes,
            countsTowardCache: false,
            waitTimeoutMs: 10_000,
            signal: mirrorSignal,
          });
        }

        const upstreamStream = await this.openMirrorSourceStream(grant, knownSize, mirrorSignal);
        await this.writeTransferFile(upstreamStream, localTempPath, diskReservation, mirrorSignal);
        const actualSize = (await stat(localTempPath)).size;
        if (knownSize !== undefined && actualSize !== knownSize) {
          throw new Error(`Telegram 源流不完整（期望 ${knownSize} 字节，实际 ${actualSize} 字节）`);
        }
        receipt = await this.storageRouter.upload({
          backendType: 'gdrive',
          objectName: grant.fileName ?? `tg_${grant.telegramFileId}`,
          mimeType: grant.mimeType ?? undefined,
          knownLength: actualSize,
          signal: mirrorSignal,
          openStream: () => createReadStream(localTempPath, { highWaterMark: 1024 * 1024 }),
        });
        if (receipt.size !== actualSize) {
          throw new Error('Google 返回的文件大小与本地暂存不一致');
        }
      }
      uploadedReceipt = receipt;
      mirrorSignal.throwIfAborted();

      const attached = await this.grantService.attachGDriveCache(grant.id, receipt.accountId, receipt.objectRef);
      if (!attached) {
        this.logger.warn(`Bot 直链 ${grant.id} 在同步 Google 缓存期间已失效/撤销，回滚删除缓存对象`);
        if (receipt.accountId) {
          await this.storageRouter.deleteRemoteObject('gdrive', receipt.accountId, receipt.objectRef).catch(() => {});
        }
        uploadedReceipt = null;
        return;
      }
      uploadedReceipt = null;
      this.logger.log(`Bot 直链 ${grant.id} 已同步至 Google 缓存 (accountId=${receipt.accountId})`);
    } catch (err) {
      if (uploadedReceipt?.accountId && uploadedReceipt.objectRef) {
        await this.storageRouter.deleteRemoteObject('gdrive', uploadedReceipt.accountId, uploadedReceipt.objectRef).catch(() => {});
      }
      const attempts = (grant.gdriveCacheAttempts ?? 0) + 1;
      await this.grantService.markGDriveCacheFailed(grant.id, err, attempts);
      this.logger.warn(
        `Bot 直链 ${grant.id} 同步 Google 缓存失败（第 ${attempts} 次，已安排重试）：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
      releaseTransferLease?.();
      if (diskReservation) {
        diskReservation.release();
        diskReservation = null;
      }
      upstreamLease?.release();
      if (uploadSessionId && this.uploadDiskBudget) {
        this.uploadDiskBudget.releaseSession(uploadSessionId);
        uploadSessionId = null;
      }
    }
  }

  private readonly cacheMirrorInflight = new Set<string>();

  /**
   * 扫描到期的 Bot 直链缓存同步（由重试 cron 调用）。
   * 并发 2：重试是后台补课，不能反过来拖慢前台下载。
   *
   * 在飞锁由 `mirrorGrantToGDriveCache` 自己持有：这里不能再预先 add，
   * 否则它会因为「ID 已在集合里」而立刻返回，该 grant 永远不会被重试。
   */
  async retryDueGDriveCacheMirrors(limit = 5): Promise<void> {
    if (this.isShuttingDown) return;
    const grants = await this.grantService.findDueGDriveCacheMirrors(limit);
    if (grants.length === 0) return;
    const queue = [...grants];
    const worker = async (): Promise<void> => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        await this.mirrorGrantToGDriveCache(next);
      }
    };
    await Promise.all([worker(), worker()]);
  }

  private async writeTransferFile(
    source: Readable,
    tempPath: string,
    reservation: DownloadReservation | null,
    signal?: AbortSignal,
  ): Promise<void> {
    await pipeline(source, async (chunks) => {
      const file = await open(tempPath, 'wx');
      try {
        for await (const chunk of chunks) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (reservation && data.length > reservation.remainingBytes) {
            this.downloadResources!.extendDiskReservation(reservation, data.length - reservation.remainingBytes);
          }
          await file.writeFile(data);
          reservation?.consume(data.length);
        }
      } finally {
        await file.close();
      }
    }, { signal });
  }

  /**
   * 从 Telegram 上游获取实时流（支持账号池感知与单账号兜底）。
   */
  private async getTelegramSourceStream(
    fileId: string,
    fileSize?: number,
    accountId?: string,
    signal?: AbortSignal,
  ): Promise<Readable> {
    const pool = this.accountPoolDownload;
    if (accountId && pool?.isActive()) {
      if (pool.hasAccount(accountId)) {
        let retryAfterMs: number | undefined;
        const opened = await pool.openSourceStream({
          accountId,
          fileId,
          expectedSize: fileSize,
          noCache: true,
          ...(signal ? {
            signal,
            onUnavailable: (failure: AccountAwareDownloadFailure) => {
              if (failure.rateLimited || failure.reason === 'source_cooling_down' || failure.reason === 'source_capacity_busy') {
                retryAfterMs = failure.retryAfterMs ?? 3_000;
              }
            },
          } : {}),
        });
        if (opened) return opened.stream;
        if (retryAfterMs) throw new TelegramTransferBackoff(retryAfterMs);
        throw new Error(`未能从指定的 Bot 账号 (${accountId}) 获取文件流`);
      }
      // 账号未在活跃账号池中：仅当匹配默认账号时才允许回退，否则 fail closed
      if (accountId !== this.defaultSourceAccountId()) {
        throw new Error(`指定的 Bot 账号 (${accountId}) 不在账号池中，拒绝跨账号回源`);
      }
    }

    if (accountId && accountId !== this.defaultSourceAccountId() && (!pool || !pool.isActive())) {
      throw new Error(`账号池未就绪且指定的 Bot 账号 (${accountId}) 与默认账号不匹配，拒绝跨账号回源`);
    }

    const realtime = await this.telegramService.getRealtimeFileStream(fileId, fileSize, {
      noCache: true,
      ...(signal && { signal, deferRateLimit: true }),
    });
    return realtime.stream;
  }

  /**
   * 回复消息：**必须由收到消息的账号发送**（池化模式），未启用池化时保持原单账号链路。
   * 返回 sent message_id 供原地更新使用。
   */
  /** 消息特效 ID：由运行环境配置（服务端目录下发，不能写死默认值），未配置则不启用 */
  private messageEffectId(): string | undefined {
    const raw = (this.configService?.get<string>('TELEGRAM_BOT_MESSAGE_EFFECT_ID') || '').trim();
    return /^\d{1,19}$/.test(raw) ? raw : undefined;
  }

  /**
   * 富文本降级链：rich → HTML → 纯文本。
   *
   * 只在**解析类错误**（400：can't parse entities / 不支持该字段 / 块过多）时降级。
   * 429 与网络错误交给底层重试，不在本层改换格式重发——那会在消息已投递的情况下造成重复。
   */
  private async deliverRendered(
    rendered: RenderedMessage,
    send: (text: string, options: TelegramTextSendOptions) => Promise<number | null>,
  ): Promise<number | null> {
    const attempts: TelegramTextSendOptions[] = [];
    const effect = rendered.messageEffectId;
    if (rendered.rich) {
      attempts.push({ richMessage: rendered.rich, replyMarkup: rendered.replyMarkup, messageEffectId: effect });
    }
    if (rendered.parseMode && rendered.rich_fallback_html) {
      attempts.push({ parseMode: rendered.parseMode, replyMarkup: rendered.replyMarkup, messageEffectId: effect });
    }
    attempts.push({ replyMarkup: rendered.replyMarkup, messageEffectId: effect });

    const plainText = this.truncateText(rendered.text);
    const htmlText = rendered.rich_fallback_html ? this.truncateText(rendered.rich_fallback_html) : plainText;

    let lastError: unknown = null;
    for (let index = 0; index < attempts.length; index++) {
      const attempt = attempts[index];
      const text = attempt.parseMode ? htmlText : plainText;
      try {
        return await send(text, attempt);
      } catch (error) {
        lastError = error;
        // 仅在「格式不被接受」时继续降级；其余错误直接上抛，避免重复投递
        if (!this.isFormatRejection(error) || index === attempts.length - 1) throw error;
        this.logger.warn(
          `富文本被拒，降级重发: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (lastError) throw lastError;
    return null;
  }

  /**
   * 是否为「格式/载荷不被接受」类错误（可安全降级重发）。
   *
   * 主路径靠**类型化异常**判定：HTTP 400 意味着请求未被受理、消息未投递，换格式重发安全。
   * 文案匹配只作兜底（覆盖池化端只带 description 的场景）。
   * 429/限流被显式排除——那种情况消息可能已投递，重发会产生重复。
   */
  private isFormatRejection(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (/429|Too Many Requests|FLOOD_WAIT/i.test(message)) return false;
    // 单账号链路：telegramRequest 在 400 分支抛出的类型化错误
    if (error instanceof TelegramRequestRejectedError) return true;
    // 池化链路：TelegramAccountError 保留原始 description，只能按文案兜底
    return [
      "can't parse entities",
      'can\'t find end',
      'unsupported start tag',
      'rich message',
      'message text is empty',
      'text must be non-empty',
      'message is too long',
      'unsupported start tag',
      'bad request: 400',
    ].some(marker => message.toLowerCase().includes(marker));
  }

  /** 截断在源文本上完成；富文本分支按同一长度约束，避免切坏结构 */
  private truncateText(text: string): string {
    return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
  }

  private async reply(
    chatId: string,
    message: string | RenderedMessage,
    replyToMessageId?: number,
    accountId?: string,
  ): Promise<number | null> {
    const rendered: RenderedMessage = typeof message === 'string' ? { text: message } : message;
    const pool = this.pool;
    const client = this.accountClient;

    // 池化启用 + 已给出 accountId：**必须由该账号发送**。
    // 即使配置解析失败（账号被移除/配置漂移）或客户端未装配，也不得回落默认账号——
    // 否则用户会从另一个 Bot 收到本账号的回复（跨账号身份错用），故一律 fail-closed。
    if (accountId && pool?.isActive()) {
      const account = client ? pool.getConfig(accountId) : null;
      if (!account || !client) {
        pool.bumpCounter('replyFailures');
        this.logger.error(
          `账号 ${accountId} 未解析到可用配置，已放弃回复（不跨账号代发，chat=${chatId}）`,
        );
        return null;
      }
      try {
        return await this.deliverRendered(rendered, (text, options) =>
          client.sendMessage(accountId, account.token, chatId, text, { ...options, replyToMessageId })
            .then(sent => sent?.messageId ?? null),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pool.bumpCounter('replyFailures');
        this.logger.error(
          `账号 ${accountId} 回复失败（不跨账号代发，chat=${chatId}）: ${message}`,
        );
        return null;
      }
    }

    // 未启用池化：保持原单账号链路
    try {
      return await this.deliverRendered(rendered, (text, options) =>
        this.telegramService.sendMessage(chatId, text, { ...options, replyToMessageId })
          .then(sent => sent?.message_id ?? null),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pool?.bumpCounter('replyFailures');
      this.logger.warn(`Bot 回复失败（忽略）: ${message}`);
      return null;
    }
  }
}
