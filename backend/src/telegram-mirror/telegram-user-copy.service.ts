import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelegramMirrorRule } from '../common/entities/telegram-mirror-rule.entity';
import { TelegramMirrorTask } from '../common/entities/telegram-mirror-task.entity';
import { TelegramAccountClientService } from '../telegram-account-pool/telegram-account-client.service';
import { TelegramAccountPoolService } from '../telegram-account-pool/telegram-account-pool.service';
import { pickUserAccount } from '../telegram-account-pool/user-account-picker';
import { TelegramAccountsService } from '../telegram-accounts/telegram-accounts.service';
import { TelegramUserClientService } from '../telegram-user/telegram-user-client.service';
import { TelegramMirrorSourceService, MirrorSourceDescriptor } from './telegram-mirror-source.service';
import { MirrorExecutionError, isAccountCredentialError } from './telegram-mirror.errors';
import { MirrorExecutionResult } from './telegram-mirror.types';

/**
 * 用户账号镜像路径：MTProto **无源复制**。
 *
 * 事实边界（不可含糊）：
 * - 「无源」只表示**不重新下载/上传文件字节**（服务端 `copyMessages`/`forwardMessages`），
 *   实现仍必须依赖源 `chat_id + message_id`；
 * - 用户账号必须同时能读源群、能写备份群；
 * - 权限不足、源消息不可访问、session 失效时**必须明确失败**，绝不允许报告成功；
 * - 该路径产生的目标消息没有「Bot 可用的 file_id」，因此**不写入副本表**，
 *   只以 `targetMessageId` 作为定位锚点（备份可用性由群内消息保证）。
 *
 * 副本认领（本路径的完成条件，见 bot 入站链路）：目标群里的消息由**用户账号**发出，
 * 因此群内每个 Bot（管理员/关闭隐私模式）都会各自收到更新，登记**自己账号的**
 * `file_id` 副本；这些副本再经「入站副本 → 站内文件」桥接后即可参与下载负载均衡。
 *
 * Bot 私聊来源的搬运：用户账号**读不到** Bot 与其它用户的私聊，`grant` 类来源直接转发
 * 必然 `permission` 失败。因此这类来源先由**接收该消息的 Bot** 用 Bot API
 * `forwardMessage`（服务端复制、零字节重传）搬到中转群，再用中转消息作为中继源锚点；
 * 锚点会写回任务行，重试时直接复用，不会重复搬运。
 */
@Injectable()
export class TelegramUserCopyService {
  private readonly logger = new Logger(TelegramUserCopyService.name);

  constructor(
    private readonly source: TelegramMirrorSourceService,
    private readonly accounts: TelegramAccountsService,
    private readonly userClient: TelegramUserClientService,
    // 以下为搬运私聊来源所需的可选依赖：未装配时 private-chat 来源会给出可诊断的 blocked 错误。
    // 必须显式 `@Inject(X)`：`X | null` 联合类型发出的是 `Object`，
    // 否则 `@Optional()` 会把解析失败静默降级成 `null`（私聊搬运能力整体缺失）。
    @Optional() @Inject(TelegramAccountClientService)
    private readonly client: TelegramAccountClientService | null = null,
    @Optional() @Inject(TelegramAccountPoolService)
    private readonly pool: TelegramAccountPoolService | null = null,
    @Optional() @Inject(ConfigService)
    private readonly configService: ConfigService | null = null,
    @Optional() @InjectRepository(TelegramMirrorTask)
    private readonly tasks: Repository<TelegramMirrorTask> | null = null,
  ) {}

  /** 自动模式下是否具备走用户复制路径的条件（仅做能力判断，不做真实调用） */
  async isUserPathViable(): Promise<boolean> {
    if (!this.userClient.isAvailable()) return false;
    try {
      const users = await this.accounts.resolveEnabledUserAccounts();
      return users.length > 0;
    } catch {
      return false;
    }
  }

  async execute(task: TelegramMirrorTask, rule: TelegramMirrorRule): Promise<MirrorExecutionResult> {
    const descriptor = await this.source.describe(task.ownerType, task.ownerId);
    const raw = this.resolveRawAnchor(task, descriptor);

    if (!this.userClient.isAvailable()) {
      throw new MirrorExecutionError(
        'user_client_unavailable',
        `MTProto 客户端不可用（${this.userClient.unavailableReason() ?? '依赖未安装'}）`,
        'blocked',
      );
    }
    // 私聊来源必须先由接收 Bot 搬运到中转群，否则用户账号必然读不到该会话
    const anchor = await this.stageIfUnreadable(task, rule, raw.chatId, raw.messageId);

    const candidates = await this.accounts.resolveEnabledUserAccounts();
    if (candidates.length === 0) {
      throw new MirrorExecutionError(
        'no_user_account',
        '没有可用（已授权且启用）的 Telegram 用户账号，无法执行无源复制',
        'blocked',
      );
    }
    const chosen = this.pickUser(candidates, rule.preferredAccountId, task.id);

    let copied: { targetChatId: string; targetMessageId: string };
    try {
      copied = await this.userClient.copyMessage({
        credentials: { apiId: chosen.apiId, apiHash: chosen.apiHash, session: chosen.session },
        sourceChatId: anchor.chatId,
        sourceMessageId: anchor.messageId,
        targetChatId: rule.targetChatId,
        // 幂等键 = 任务 + 目标群 + 执行账号。
        //
        // 「账号」必须在键内：账号选择是确定性的（见 pickUser），因此同一任务的所有重试都会
        // 派生出同一个 random_id，服务端据此去重，不会留下重复副本。
        // 「目标群」也必须在键内：规则允许在任务重试期间被改动，若只用任务 + 账号，
        // 同一个 random_id 会被服务端按去重返回**旧目标群**的消息 ID，而结果里的
        // targetChatId 是新群——定位与实际位置不一致。
        idempotencyKey: `${task.id}:${rule.targetChatId}:${chosen.id}`,
      });
    } catch (error) {
      // 凭据失效必须让管理员可见：把实际使用的账号标记为 degraded（否则账号会一直
      // 显示 active，任务却持续 blocked，运维无从下手）
      if (isAccountCredentialError(error)) {
        await this.accounts.markDegraded(
          chosen.id,
          'user_session_invalid',
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }

    this.logger.log(
      `镜像完成（user_copy / 无源复制）：${task.ownerType}:${task.ownerId} → 账号 ${chosen.id} / chat ${copied.targetChatId}`,
    );
    return {
      targetAccountId: chosen.id,
      targetChatId: copied.targetChatId,
      targetMessageId: copied.targetMessageId,
      // 用户复制的目标消息没有 Bot API file_id（不登记副本表，避免跨体系误用）；
      // 各 Bot 会在收到群内该消息后登记**各自**的副本。
      targetTelegramFileId: '',
      fileSize: descriptor.fileSize,
      mode: 'user_copy',
    };
  }

  // ---------------- 源锚点解析 ----------------

  /** 任务/描述里已有的源锚点；缺失即 blocked（不允许随机挑账号尝试） */
  private resolveRawAnchor(
    task: TelegramMirrorTask,
    descriptor: MirrorSourceDescriptor,
  ): { chatId: string; messageId: string } {
    const chatId = String(task.sourceChatId ?? descriptor.chatId ?? '').trim();
    const messageId = String(task.sourceMessageId ?? descriptor.messageId ?? '').trim();
    if (!chatId || !messageId) {
      throw new MirrorExecutionError(
        'source_message_unresolved',
        '缺少源消息定位（chat_id + message_id），无法执行无源复制；'
        + '该事件应回退 Bot 重新上传，或修复源消息登记后重试',
        'blocked',
      );
    }
    return { chatId, messageId };
  }

  /**
   * 若源锚点位于**用户账号不可读**的会话（Bot 与用户的私聊），先由接收该消息的 Bot
   * 用 Bot API 服务端转发到中转群，并返回中转消息作为新的源锚点。
   *
   * 群/频道的 chat id 为负数；正数即私聊的用户 ID。无法判定的标识（非数字）按群处理，
   * 保持既有行为不变。
   */
  private async stageIfUnreadable(
    task: TelegramMirrorTask,
    rule: TelegramMirrorRule,
    chatId: string,
    messageId: string,
  ): Promise<{ chatId: string; messageId: string }> {
    if (!this.isPrivateChat(chatId)) return { chatId, messageId };

    const staging = (rule.sourceChatId || '').trim()
      || (this.configService?.get<string>('TELEGRAM_ARCHIVE_CHAT_ID') || '').trim();
    if (!staging) {
      throw new MirrorExecutionError(
        'relay_staging_chat_missing',
        '源消息位于 Bot 与用户的私聊（用户账号读不到该会话），但规则未配置源群、'
        + '也未配置 TELEGRAM_ARCHIVE_CHAT_ID，无法搬运到用户账号可读的群',
        'blocked',
      );
    }
    if (this.isPrivateChat(staging)) {
      throw new MirrorExecutionError(
        'relay_staging_chat_invalid',
        `中转群必须是群或频道（chat id 为负数），当前配置为私聊 ${staging}`,
        'blocked',
      );
    }
    if (staging === rule.targetChatId) {
      // 搬到备份群本身没有意义：Bot 发出的消息其它 Bot 看不到，副本仍无法被认领；
      // 且随后「从备份群中继到备份群」会产生语义混乱。明确失败，等运维修正配置。
      throw new MirrorExecutionError(
        'relay_staging_chat_conflict',
        '中转群与备份群相同：Bot 转发进备份群的消息其它 Bot 看不到，无法达成副本认领；'
        + '请把规则源群或 TELEGRAM_ARCHIVE_CHAT_ID 配置为独立的中转群',
        'blocked',
      );
    }
    if (!this.client) {
      throw new MirrorExecutionError(
        'relay_client_unavailable',
        '账号级 Bot API 客户端未装配，无法把 Bot 私聊的源消息搬运到中转群',
        'blocked',
      );
    }

    const bot = await this.resolveForwardBot(task.sourceAccountId ?? null);
    if (!bot) {
      throw new MirrorExecutionError(
        'relay_forward_bot_unresolved',
        `无法确认收到该文件的 Bot 账号（sourceAccountId=${task.sourceAccountId ?? 'null'}）的可用凭据，`
        + '无法把私聊消息搬运到中转群；请确认该账号仍启用且凭据可解密',
        'blocked',
      );
    }

    const forwarded = await this.client.forwardMessage(bot.accountId, bot.token, staging, chatId, messageId);
    await this.persistRelayAnchor(task, staging, forwarded.messageId);
    this.logger.log(
      `已把 Bot 私聊源消息搬运到中转群（任务 ${task.id} / 账号 ${bot.accountId} / 新消息 ${forwarded.messageId}）`,
    );
    return { chatId: staging, messageId: forwarded.messageId };
  }

  /**
   * 固化中转锚点到任务行。
   *
   * 为什么要落库：Bot API 的 `forwardMessage` **没有幂等键**，重试会再搬一次并在中转群
   * 留下重复消息。写回任务行后，后续所有重试都会命中「源锚点已是群消息 → 无需搬运」。
   */
  private async persistRelayAnchor(
    task: TelegramMirrorTask,
    chatId: string,
    messageId: string,
  ): Promise<void> {
    task.sourceChatId = chatId;
    task.sourceMessageId = messageId;
    if (!this.tasks) return;
    try {
      await this.tasks.update({ id: task.id }, { sourceChatId: chatId, sourceMessageId: messageId });
    } catch (error) {
      // 用 error 级：写回失败意味着重试会**再搬一次**并在中转群留下重复消息，
      // 属于需要运维关注的状态（消费者通过 claim 原子领取任务，同一任务不会并发执行，
      // 因此重复搬运只可能由「写库失败后重新载入任务」引起）。
      this.logger.error(
        `中转锚点写回任务失败（任务 ${task.id}）：${error instanceof Error ? error.message : String(error)}`
        + '——该任务重试时会重复搬运一次，请关注中转群消息',
      );
    }
  }

  /** 解析搬运所需的 Bot 凭据（只使用「收到该消息的那个账号」，绝不跨账号代搬） */
  private async resolveForwardBot(poolAccountId: string | null): Promise<{ accountId: string; token: string } | null> {
    const wanted = (poolAccountId || '').trim();
    if (wanted && this.pool) {
      const config = this.pool.getConfig(wanted);
      if (config?.enabled && config.token) return { accountId: config.id, token: config.token };
    }
    const envToken = (this.configService?.get<string>('TELEGRAM_BOT_TOKEN') || '').trim();
    if (envToken.includes(':')) {
      const envBotId = envToken.split(':')[0];
      if (!wanted || wanted === envBotId) return { accountId: envBotId, token: envToken };
    }
    try {
      const panel = await this.accounts.resolveEnabledBotAccounts();
      const match = panel.find((item) => item.accountId === wanted || item.id === wanted);
      if (match) return { accountId: match.accountId, token: match.token };
    } catch (error) {
      this.logger.warn(`读取面板 Bot 账号失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }

  /** 私聊判定：Telegram 群/频道 chat id 恒为负数，用户 ID 为正数 */
  private isPrivateChat(chatId: string): boolean {
    const numeric = Number(chatId);
    return Number.isFinite(numeric) && numeric > 0;
  }

  // ---------------- 选号 ----------------

  /**
   * 优先规则指定账号；否则按权重展平后用**稳定种子**选择（同权重账号均匀分流）。
   *
   * 实现委托给无依赖纯函数 `pickUserAccount`，与账号池的用户账号中继（策略 B）
   * **共用同一份选号语义**，避免两处实现漂移出「一个用种子、一个用游标」的不一致。
   */
  private pickUser<T extends { id: string; weight: number }>(
    candidates: T[],
    preferredAccountId: string | null | undefined,
    seed: string,
  ): T {
    const picked = pickUserAccount(candidates, preferredAccountId, seed);
    if (picked.fallbackFromPreferred) {
      this.logger.warn(`规则指定的优先用户账号 ${preferredAccountId} 不可用，改为按权重选择`);
    }
    return picked.account;
  }
}
