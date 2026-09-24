import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from '../telegram/telegram.service';
import { AuditService } from '../common/services/audit.service';
import { AuditStatus } from '../common/entities/audit-log.entity';
import type { TelegramMessage, TelegramUpdate, TelegramUser } from '../telegram/telegram.types';
import { FileCopyService } from '../telegram-account-pool/file-copy.service';
import { ReplicationAttemptService } from '../telegram-account-pool/replication-attempt.service';
import { TelegramAccountClientService } from '../telegram-account-pool/telegram-account-client.service';
import { TelegramAccountPoolService } from '../telegram-account-pool/telegram-account-pool.service';
import { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';
import { TelegramMirrorConfigService } from '../telegram-mirror/telegram-mirror-config.service';
import { TelegramMirrorTriggerService } from '../telegram-mirror/telegram-mirror-trigger.service';
import { TelegramBotConfigService } from './telegram-bot-config.service';
import { TelegramBotGrantService } from './telegram-bot-grant.service';
import { TelegramBotQuotaService } from './telegram-bot-quota.service';
import { TelegramBotAdminService } from './telegram-bot-admin.service';
import { TelegramBotIdentity } from './telegram-bot.types';

/** Telegram 单条消息文本上限（预留截断余量） */
const MAX_MESSAGE_LENGTH = 3800;
/** /link_query 结果最多展示条数（避免刷屏与超长消息） */
const MAX_LINK_QUERY_RESULTS = 20;

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
export class TelegramBotDispatchService {
  private readonly logger = new Logger(TelegramBotDispatchService.name);

  constructor(
    private readonly telegramService: TelegramService,
    private readonly botConfigService: TelegramBotConfigService,
    private readonly quotaService: TelegramBotQuotaService,
    private readonly grantService: TelegramBotGrantService,
    private readonly adminService: TelegramBotAdminService,
    private readonly auditService: AuditService,
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
  ) {}

  /** 处理单条更新（异常不外抛，避免中断轮询循环） */
  async handleUpdate(update: TelegramUpdate, context?: BotUpdateContext): Promise<void> {
    const accountId = context?.accountId;
    try {
      const message = update.message;
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
      if (message.document) {
        await this.handleDocument(message, identity, accountId);
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
      await this.reply(chatId, this.buildHelpText(), message.message_id, accountId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`处理 Bot 更新失败（已忽略）: ${message}`);
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
        await this.reply(chatId, this.buildHelpText(), message.message_id, accountId);
        return;
      case '/id':
        await this.reply(chatId, `你的 Telegram 用户 ID：${identity.telegramUserId}`, message.message_id, accountId);
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
        await this.reply(chatId, '未知命令，发送 /help 查看可用命令。', message.message_id, accountId);
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
      await this.reply(chatId, '你在白名单中，不限每日文件数。', replyToMessageId, accountId);
      return;
    }
    const usageDate = this.quotaService.getBusinessDate(config.quotaTimezone);
    const used = await this.quotaService.getUsed(identity.telegramUserId, usageDate);
    const remaining = Math.max(0, config.dailyLimit - used);
    await this.reply(
      chatId,
      `今日已使用 ${used} / ${config.dailyLimit}，剩余 ${remaining} 次。\n（切日时区：${config.quotaTimezone}）`,
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
        await this.reply(chatId, '未知命令，发送 /help 查看可用命令。', replyToMessageId, accountId);
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
      await this.reply(chatId, '白名单为空。', replyToMessageId, accountId);
      return;
    }
    const shown = list.slice(0, MAX_LINK_QUERY_RESULTS);
    const lines = shown.map((item, index) => `${index + 1}. ${item.telegramUserId}`);
    const suffix = list.length > shown.length ? `\n……共 ${list.length} 个（已截断）` : `\n共 ${list.length} 个`;
    await this.reply(chatId, `白名单：\n${lines.join('\n')}${suffix}`, replyToMessageId, accountId);
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
    const lines = shown.map((item, index) => {
      const name = item.grant.fileName || '(未命名)';
      const expires = new Date(item.grant.expiresAt).toISOString();
      if (item.url) {
        return `${index + 1}. ${name}\n   过期：${expires}\n   ${item.url}`;
      }
      return `${index + 1}. ${name}\n   过期：${expires}\n   前缀：${item.prefix}（未启用加密存储，无法回放完整链接，请重新签发）`;
    });
    const suffix = results.length > shown.length ? `\n……共 ${results.length} 条（已截断）` : '';
    await this.reply(chatId, `直链（${target}）：\n${lines.join('\n')}${suffix}`, replyToMessageId, accountId);
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
    await this.reply(chatId, '直链已撤销，立即失效。', replyToMessageId, accountId);
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
        await this.recordRelayClaim(uniqueId, bridged.matchedFileIds, accountId, chatId);
      } catch (error) {
        pool.bumpCounter('inboundRegistrationFailures');
        const text = error instanceof Error ? error.message : String(error);
        this.logger.warn(`入站副本登记失败（忽略，不影响直链签发）: ${text}`);
      }
    }

    // 归档转发与副本登记解耦：即使登记失败也保留审计留痕。
    const archiveChatId = (this.configService?.get<string>('TELEGRAM_ARCHIVE_CHAT_ID') || '').trim();
    const account = pool.getConfig(accountId);
    if (!archiveChatId || !account || !this.accountClient || !chatId || !messageId) return;
    if (chatId === archiveChatId) return; // 已在归档群，避免自转发循环

    // 来自「镜像群」或「主群」的消息只登记副本、不再归档转发：这两类群都是扩散落点，
    // 群内每条消息会被群内每个 Bot 各收到一次，逐个转发会让归档群消息量按 Bot 数（N）放大。
    if (await this.shouldSuppressArchiveForward(chatId)) {
      this.logger.debug(`来源为扩散落点（镜像群/主群，chat=${chatId}），跳过归档转发以避免 N 倍放大`);
      return;
    }
    try {
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
   * 把 Bot 认领事件回写到扩散轮次。
   *
   * 为什么要写两个命名空间：轮次是按**发起扩散时的 owner** 建的（镜像任务用
   * `file:<站内 id>` 或 `grant:<授权 id>`），而认领天然只知道 `file_unique_id`。
   * 只写一个会让「中继成功」与「Bot 认领」在后台对不上，认领超时会被误判。
   *
   * 为什么必须带 `targetChatId`：**每条启用规则一个镜像群、各自一条活跃轮次**，
   * 同一文件在多个群同时中继时，不带目标群的认领会落到别的群的轮次上。
   *
   * 找不到匹配的进行中轮次时 `recordClaim` 内部静默返回（普通群消息本就没有对应轮次）。
   */
  private async recordRelayClaim(
    uniqueId: string,
    matchedFileIds: string[],
    accountId: string,
    targetChatId?: string | null,
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
  }

  private async handleDocument(
    message: TelegramMessage,
    identity: TelegramBotIdentity,
    accountId?: string,
  ): Promise<void> {
    const doc = message.document;
    if (!doc || !doc.file_id) return;
    const chatId = String(message.chat.id);
    const messageId = String(message.message_id);

    // 池化模式：先把「哪个账号收到了这个文件」落库（幂等），再走原有直链签发流程
    await this.registerInboundCopyAndForward(message, accountId);

    // 幂等：同一条消息只签发一次、只扣一次配额
    const existing = await this.grantService.findByMessage(identity.telegramUserId, chatId, messageId);
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

    await this.auditDocumentReceived(identity, message, fileSize);

    // 域名解析（fail-closed）：无可用可信域名时拒绝签发，且不消耗配额
    const origin = await this.botConfigService.resolveSiteOriginAsync();
    if (!origin) {
      await this.reply(
        chatId,
        '服务暂不可用：管理员尚未配置站点域名（直链域名）。请联系管理员在后台「Telegram Bot 设置」中配置。',
        message.message_id,
        accountId,
      );
      return;
    }

    const config = await this.botConfigService.getConfig();
    const usageDate = this.quotaService.getBusinessDate(config.quotaTimezone);
    const whitelisted = await this.quotaService.isWhitelisted(identity.telegramUserId);

    let quotaConsumed = false;
    if (!whitelisted) {
      const quota = await this.quotaService.consume(identity.telegramUserId, usageDate, config.dailyLimit);
      if (!quota.allowed) {
        this.auditService.log({
          action: 'telegram_bot_quota_denied',
          resourceType: 'telegram_bot_quota',
          resourceId: identity.telegramUserId,
          status: AuditStatus.FAILURE,
          metadata: {
            telegramUserId: identity.telegramUserId,
            telegramUsername: identity.username,
            quotaDate: usageDate,
            quotaUsed: quota.used,
            quotaLimit: config.dailyLimit,
          },
        });
        await this.reply(
          chatId,
          `今日额度已用完（${config.dailyLimit} 个文件/天）。明日将自动重置，或联系管理员加入白名单。`,
          message.message_id,
          accountId,
        );
        return;
      }
      quotaConsumed = true;
    }
    const quotaUsed = await this.quotaService.getUsed(identity.telegramUserId, usageDate);

    try {
      const { grant, token } = await this.grantService.issue(
        {
          telegramUserId: identity.telegramUserId,
          username: identity.username,
          displayName: identity.displayName,
          chatId,
          messageId,
          telegramFileId: doc.file_id,
          // 回退安全锚点：池化模式=收到消息的账号；单账号模式=默认 Token 的 botId
          sourceAccountId: accountId ?? this.defaultSourceAccountId(),
          fileName: this.sanitizePlain(doc.file_name, 255),
          mimeType: this.sanitizePlain(doc.mime_type, 128),
          fileSize: fileSize === null ? null : String(fileSize),
        },
        config.linkTtlHours,
      );

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
        `文件已收到：${fileName}\n下载直链（${config.linkTtlHours} 小时内有效，仅受时间限制）：\n${url}`,
        message.message_id,
        accountId,
      );

      // 镜像备份（Bot 入站）：grant 已持久化后才触发；镜像失败不回滚签发与配额
      void this.triggerInboundMirror(grant, accountId);
    } catch (error) {
      // 签发失败：归还已消耗的配额，避免用户白白损失额度
      if (quotaConsumed) {
        await this.quotaService.refund(identity.telegramUserId, usageDate);
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`直链签发失败: ${detail}`);
      await this.reply(chatId, '内部错误：生成下载链接失败，请稍后重试。', message.message_id, accountId);
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

  private buildHelpText(): string {
    return [
      '发送「文件」（Telegram 附件 → 文件）即可获得下载直链。',
      '直链仅在有效期内可用，不限下载次数。',
      '',
      '可用命令：',
      '/help — 显示本帮助',
      '/id — 查看你的 TG 用户 ID',
      '/quota — 查看今日剩余额度',
      '',
      '管理员命令（仅私聊）：',
      '/wl_add <TG用户ID> — 加入白名单',
      '/wl_remove <TG用户ID> — 移出白名单',
      '/wl_list — 列出白名单',
      '/link_query <TG用户ID> — 查询有效直链',
      '/link_revoke <直链URL或Token> — 撤销直链',
    ].join('\n');
  }

  /**
   * 回复消息：**必须由收到消息的账号发送**（池化模式），未启用池化时保持原单账号链路。
   *
   * 安全约束：按账号发送失败时**不得**改用默认账号代发——那会让用户从另一个 Bot 收到
   * 本账号的回复（身份错用），且与 Grant 的 `sourceAccountId` 记录不一致。
   * 失败只记录结构化日志与计数，便于在「池化已启用但回复总失败」时被发现。
   */
  private async reply(
    chatId: string,
    text: string,
    replyToMessageId?: number,
    accountId?: string,
  ): Promise<void> {
    const content = text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
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
        return;
      }
      try {
        await client.sendMessage(accountId, account.token, chatId, content, { replyToMessageId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pool.bumpCounter('replyFailures');
        this.logger.error(
          `账号 ${accountId} 回复失败（不跨账号代发，chat=${chatId}）: ${message}`,
        );
      }
      return;
    }

    // 未启用池化：保持原单账号链路
    try {
      await this.telegramService.sendMessage(chatId, content, { replyToMessageId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pool?.bumpCounter('replyFailures');
      this.logger.warn(`Bot 回复失败（忽略）: ${message}`);
    }
  }
}
