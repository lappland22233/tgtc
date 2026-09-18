import { Injectable, Logger } from '@nestjs/common';
import { TelegramService } from '../telegram/telegram.service';
import { AuditService } from '../common/services/audit.service';
import { AuditStatus } from '../common/entities/audit-log.entity';
import type { TelegramMessage, TelegramUpdate, TelegramUser } from '../telegram/telegram.types';
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
 * 入站更新分发：私聊校验、命令路由、document 提取、配额判定与直链签发。
 *
 * 处理顺序（重要）：
 *   私聊校验 → 幂等命中 → 命令 → document 提取 → 域名解析(fail-closed) → 配额 → 签发 → 回复
 * 域名解析在配额扣减之前，避免因管理员未配置域名而白白消耗用户额度。
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
  ) {}

  /** 处理单条更新（异常不外抛，避免中断轮询循环） */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    try {
      const message = update.message;
      if (!message) return;
      // D7：仅私聊；群组/频道消息静默忽略，不回复、不扣配额
      if (!message.chat || message.chat.type !== 'private') return;
      if (!message.from || message.from.is_bot) return;

      const identity = this.normalizeIdentity(message.from);
      const chatId = String(message.chat.id);
      const text = (message.text || '').trim();

      if (text.startsWith('/')) {
        await this.handleCommand(message, identity, text);
        return;
      }
      if (message.document) {
        await this.handleDocument(message, identity);
        return;
      }
      if (this.isNonDocumentMedia(message)) {
        await this.reply(chatId, '请以「文件」方式发送：在 Telegram 中选择附件 → 文件，而不是图片/视频。', message.message_id);
        return;
      }
      await this.reply(chatId, this.buildHelpText(), message.message_id);
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
  ): Promise<void> {
    const chatId = String(message.chat.id);
    // 支持 /cmd@BotName 形式
    const [rawCommand, ...args] = rawText.split(/\s+/);
    const command = rawCommand.split('@')[0].toLowerCase();

    switch (command) {
      case '/start':
      case '/help':
        await this.reply(chatId, this.buildHelpText(), message.message_id);
        return;
      case '/id':
        await this.reply(chatId, `你的 Telegram 用户 ID：${identity.telegramUserId}`, message.message_id);
        return;
      case '/quota':
        await this.handleQuotaCommand(chatId, identity, message.message_id);
        return;
      case '/wl_add':
      case '/wl_remove':
      case '/wl_list':
      case '/link_query':
      case '/link_revoke':
        await this.handleAdminCommand(command, args, chatId, identity, message.message_id, message.chat.type);
        return;
      default:
        await this.reply(chatId, '未知命令，发送 /help 查看可用命令。', message.message_id);
    }
  }

  private async handleQuotaCommand(
    chatId: string,
    identity: TelegramBotIdentity,
    replyToMessageId: number,
  ): Promise<void> {
    const config = await this.botConfigService.getConfig();
    const whitelisted = await this.quotaService.isWhitelisted(identity.telegramUserId);
    if (whitelisted) {
      await this.reply(chatId, '你在白名单中，不限每日文件数。', replyToMessageId);
      return;
    }
    const usageDate = this.quotaService.getBusinessDate(config.quotaTimezone);
    const used = await this.quotaService.getUsed(identity.telegramUserId, usageDate);
    const remaining = Math.max(0, config.dailyLimit - used);
    await this.reply(
      chatId,
      `今日已使用 ${used} / ${config.dailyLimit}，剩余 ${remaining} 次。\n（切日时区：${config.quotaTimezone}）`,
      replyToMessageId,
    );
  }

  private async handleAdminCommand(
    command: string,
    args: string[],
    chatId: string,
    identity: TelegramBotIdentity,
    replyToMessageId: number,
    chatType: string,
  ): Promise<void> {
    if (!this.adminService.isAdmin(identity.telegramUserId)) {
      // 越权：只回通用拒绝，且不泄露命令内容
      this.adminService.auditCommandDenied(identity, command, chatType);
      await this.reply(chatId, '该命令仅限管理员使用。', replyToMessageId);
      return;
    }

    switch (command) {
      case '/wl_add':
        await this.handleWhitelistAdd(args, chatId, identity, replyToMessageId);
        return;
      case '/wl_remove':
        await this.handleWhitelistRemove(args, chatId, identity, replyToMessageId);
        return;
      case '/wl_list':
        await this.handleWhitelistList(chatId, replyToMessageId);
        return;
      case '/link_query':
        await this.handleLinkQuery(args, chatId, identity, replyToMessageId);
        return;
      case '/link_revoke':
        await this.handleLinkRevoke(args, chatId, identity, replyToMessageId);
        return;
      default:
        await this.reply(chatId, '未知命令，发送 /help 查看可用命令。', replyToMessageId);
    }
  }

  private async handleWhitelistAdd(
    args: string[],
    chatId: string,
    identity: TelegramBotIdentity,
    replyToMessageId: number,
  ): Promise<void> {
    const target = (args[0] || '').trim();
    if (!/^\d{1,20}$/.test(target)) {
      await this.reply(chatId, '用法：/wl_add <TG用户ID>', replyToMessageId);
      return;
    }
    const { created } = await this.adminService.addWhitelist(identity, target);
    await this.reply(
      chatId,
      created ? `已加入白名单：${target}` : `${target} 已在白名单中。`,
      replyToMessageId,
    );
  }

  private async handleWhitelistRemove(
    args: string[],
    chatId: string,
    identity: TelegramBotIdentity,
    replyToMessageId: number,
  ): Promise<void> {
    const target = (args[0] || '').trim();
    if (!/^\d{1,20}$/.test(target)) {
      await this.reply(chatId, '用法：/wl_remove <TG用户ID>', replyToMessageId);
      return;
    }
    const removed = await this.adminService.removeWhitelist(identity, target);
    await this.reply(
      chatId,
      removed ? `已移出白名单：${target}` : `${target} 不在白名单中。`,
      replyToMessageId,
    );
  }

  private async handleWhitelistList(chatId: string, replyToMessageId: number): Promise<void> {
    const list = await this.adminService.listWhitelist();
    if (list.length === 0) {
      await this.reply(chatId, '白名单为空。', replyToMessageId);
      return;
    }
    const shown = list.slice(0, MAX_LINK_QUERY_RESULTS);
    const lines = shown.map((item, index) => `${index + 1}. ${item.telegramUserId}`);
    const suffix = list.length > shown.length ? `\n……共 ${list.length} 个（已截断）` : `\n共 ${list.length} 个`;
    await this.reply(chatId, `白名单：\n${lines.join('\n')}${suffix}`, replyToMessageId);
  }

  private async handleLinkQuery(
    args: string[],
    chatId: string,
    identity: TelegramBotIdentity,
    replyToMessageId: number,
  ): Promise<void> {
    const target = (args[0] || '').trim();
    if (!/^\d{1,20}$/.test(target)) {
      await this.reply(chatId, '用法：/link_query <TG用户ID>', replyToMessageId);
      return;
    }
    const results = await this.adminService.queryLinks(identity, target);
    if (results.length === 0) {
      await this.reply(chatId, `${target} 当前没有有效的直链。`, replyToMessageId);
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
    await this.reply(chatId, `直链（${target}）：\n${lines.join('\n')}${suffix}`, replyToMessageId);
  }

  private async handleLinkRevoke(
    args: string[],
    chatId: string,
    identity: TelegramBotIdentity,
    replyToMessageId: number,
  ): Promise<void> {
    const input = (args[0] || '').trim();
    if (!input) {
      await this.reply(chatId, '用法：/link_revoke <直链URL或Token>', replyToMessageId);
      return;
    }
    const result = await this.adminService.revokeByToken(identity, input);
    if (!result.ok) {
      await this.reply(
        chatId,
        result.reason === 'invalid_input' ? '无法解析直链，请粘贴完整直链 URL 或 Token。' : '未找到对应的直链（可能已过期或已撤销）。',
        replyToMessageId,
      );
      return;
    }
    await this.reply(chatId, '直链已撤销，立即失效。', replyToMessageId);
  }

  // ---------------- 文件处理 ----------------

  private async handleDocument(message: TelegramMessage, identity: TelegramBotIdentity): Promise<void> {
    const doc = message.document;
    if (!doc || !doc.file_id) return;
    const chatId = String(message.chat.id);
    const messageId = String(message.message_id);

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
        );
      } else {
        await this.reply(chatId, '该文件的链接已失效（过期或已撤销），请重新发送文件以获取新链接。', message.message_id);
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
          fileName,
        },
      });

      await this.reply(
        chatId,
        `文件已收到：${fileName}\n下载直链（${config.linkTtlHours} 小时内有效，仅受时间限制）：\n${url}`,
        message.message_id,
      );
    } catch (error) {
      // 签发失败：归还已消耗的配额，避免用户白白损失额度
      if (quotaConsumed) {
        await this.quotaService.refund(identity.telegramUserId, usageDate);
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`直链签发失败: ${detail}`);
      await this.reply(chatId, '内部错误：生成下载链接失败，请稍后重试。', message.message_id);
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

  /** 回复消息（失败只记录日志，不影响业务流程） */
  private async reply(chatId: string, text: string, replyToMessageId?: number): Promise<void> {
    const content = text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
    try {
      await this.telegramService.sendMessage(chatId, content, { replyToMessageId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Bot 回复失败（忽略）: ${message}`);
    }
  }
}
