import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { TelegramMirrorRule } from '../common/entities/telegram-mirror-rule.entity';
import { TelegramMirrorTask } from '../common/entities/telegram-mirror-task.entity';
import { TelegramAccountsService } from '../telegram-accounts/telegram-accounts.service';
import { TelegramUserClientService } from '../telegram-user/telegram-user-client.service';
import { TelegramMirrorSourceService } from './telegram-mirror-source.service';
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
 */
@Injectable()
export class TelegramUserCopyService {
  private readonly logger = new Logger(TelegramUserCopyService.name);

  constructor(
    private readonly source: TelegramMirrorSourceService,
    private readonly accounts: TelegramAccountsService,
    private readonly userClient: TelegramUserClientService,
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
    const sourceChatId = task.sourceChatId ?? descriptor.chatId;
    const sourceMessageId = task.sourceMessageId ?? descriptor.messageId;

    if (!sourceChatId || !sourceMessageId) {
      throw new MirrorExecutionError(
        'source_message_unresolved',
        '缺少源消息定位（chat_id + message_id），无法执行无源复制；'
        + '该事件应回退 Bot 重新上传，或修复源消息登记后重试',
        'blocked',
      );
    }
    if (!this.userClient.isAvailable()) {
      throw new MirrorExecutionError(
        'user_client_unavailable',
        `MTProto 客户端不可用（${this.userClient.unavailableReason() ?? '依赖未安装'}）`,
        'blocked',
      );
    }

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
        sourceChatId,
        sourceMessageId,
        targetChatId: rule.targetChatId,
        // 幂等键 = 任务 + 执行账号：账号选择是确定性的（见 pickUser），因此同一任务
        // 的所有重试都会派生出同一个 random_id，服务端据此去重，不会留下重复副本。
        idempotencyKey: `${task.id}:${chosen.id}`,
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
      // 用户复制的目标消息没有 Bot API file_id（不登记副本表，避免跨体系误用）
      targetTelegramFileId: '',
      fileSize: descriptor.fileSize,
      mode: 'user_copy',
    };
  }

  /**
   * 优先规则指定账号；否则按权重展平后用**稳定种子**选择（同权重账号均匀分流）。
   *
   * 「确定性」是幂等的前提：MTProto 的 `random_id` 去重维度是**发送者账号**，只有同一
   * 任务每次重试都落到同一账号，确定性 `random_id` 才能阻止重复复制。原实现用进程内
   * 游标轮转，重试会换账号 → 换一个发送者重新复制一份，属于「重试不幂等」的直接成因。
   *
   * 用任务 ID 作种子而非游标，还能让账号分流在**多进程/重启后保持一致**。
   */
  private pickUser<T extends { id: string; weight: number }>(
    candidates: T[],
    preferredAccountId: string | null | undefined,
    seed: string,
  ): T {
    if (preferredAccountId) {
      const preferred = candidates.find((item) => item.id === preferredAccountId);
      if (preferred) return preferred;
      this.logger.warn(`规则指定的优先用户账号 ${preferredAccountId} 不可用，改为按权重选择`);
    }
    const expanded: T[] = [];
    for (const item of candidates) {
      const weight = Math.max(1, Math.min(Math.floor(item.weight) || 1, 10));
      for (let index = 0; index < weight; index += 1) expanded.push(item);
    }
    const digest = createHash('sha256').update(seed).digest();
    return expanded[digest.readUInt32BE(0) % expanded.length];
  }
}
