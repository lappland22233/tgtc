import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { File } from '../common/entities/file.entity';
import { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';
import { FileCopyService } from '../telegram-account-pool/file-copy.service';
import { TelegramCopyOwnerType } from '../common/entities/telegram-file-copy.entity';
import { MirrorExecutionError } from './telegram-mirror.errors';

/**
 * 镜像源文件描述：副本扩散链路的**源事实**。
 *
 * `chatId + messageId` 是「搬运到主群」的输入（持有该消息的 Bot 把消息服务端转发进主群），
 * 中继本身不再直接使用它们——用户账号只从主群锚点转发。
 */
export interface MirrorSourceDescriptor {
  /** 账号级 Telegram file_id（可能为空：仅当存在副本记录时才可知） */
  fileId: string | null;
  fileSize: number;
  fileName: string;
  /** 源消息定位（搬运到主群必须持有） */
  chatId: string | null;
  messageId: string | null;
  /** 产生 file_id 的账号（搬运只能由它执行，绝不跨账号代搬） */
  sourceAccountId: string | null;
  /** 任务幂等键的版本分量（file=uploadVersion，其余为 1） */
  sourceVersion: number;
}

/**
 * 镜像源解析：把「镜像任务的归属对象」翻译成可执行的源事实。
 *
 * 三种归属：
 * - `file`：站内文件（普通 Web 上传）——优先读 `files` 主副本定位字段；
 * - `grant`：Bot 私聊入站文件——读 `telegram_bot_file_grants` 的 chat/message/file_id；
 * - `fileUnique`：仅知跨账号稳定的 `file_unique_id`——从副本表取任一 ready 副本。
 *
 * 定位不到源消息时**必须阻塞并给出原因**，不允许随机挑账号尝试
 * （那会产出一份来路不明的备份）。
 */
@Injectable()
export class TelegramMirrorSourceService {
  private readonly logger = new Logger(TelegramMirrorSourceService.name);

  constructor(
    @InjectRepository(File)
    private readonly files: Repository<File>,
    @InjectRepository(TelegramBotFileGrant)
    private readonly grants: Repository<TelegramBotFileGrant>,
    private readonly copies: FileCopyService,
  ) {}

  async describe(ownerType: TelegramCopyOwnerType, ownerId: string): Promise<MirrorSourceDescriptor> {
    if (ownerType === 'grant') return this.describeGrant(ownerId);
    if (ownerType === 'file') return this.describeFile(ownerId);
    return this.describeFileUnique(ownerId);
  }

  private async describeFile(ownerId: string): Promise<MirrorSourceDescriptor> {
    const file = await this.files.findOne({ where: { id: ownerId } });
    if (!file) {
      throw new MirrorExecutionError('source_file_missing', '站内文件不存在（可能已被物理删除）', 'blocked');
    }
    const descriptor: MirrorSourceDescriptor = {
      fileId: file.telegramFileId || null,
      fileSize: Number(file.size) || 0,
      fileName: file.originalName || file.filename || 'mirror-backup',
      chatId: file.telegramChatId ?? null,
      messageId: file.telegramMessageId ?? null,
      sourceAccountId: file.telegramSourceAccountId ?? null,
      sourceVersion: Number(file.uploadVersion) || 1,
    };
    if (descriptor.fileId) return descriptor;

    // 主副本 file_id 缺失（历史数据/异常状态）：尝试用副本表兜底
    const fromCopies = await this.describeFromCopies('file', ownerId, descriptor.fileName);
    return fromCopies ?? descriptor;
  }

  private async describeGrant(ownerId: string): Promise<MirrorSourceDescriptor> {
    const grant = await this.grants.findOne({ where: { id: ownerId } });
    if (!grant) {
      throw new MirrorExecutionError('source_grant_missing', 'Bot 直链记录不存在', 'blocked');
    }
    return {
      fileId: grant.telegramFileId || null,
      fileSize: Number(grant.fileSize ?? 0) || 0,
      fileName: grant.fileName || 'mirror-backup',
      chatId: grant.chatId ? String(grant.chatId) : null,
      messageId: grant.messageId ? String(grant.messageId) : null,
      sourceAccountId: grant.sourceAccountId ?? null,
      // Bot 私聊入站没有「覆盖上传」概念：授权记录不可变，版本恒为 1
      sourceVersion: 1,
    };
  }

  private async describeFileUnique(ownerId: string): Promise<MirrorSourceDescriptor> {
    const fromCopies = await this.describeFromCopies('fileUnique', ownerId, 'mirror-backup');
    if (fromCopies) return fromCopies;
    throw new MirrorExecutionError(
      'no_source_copy',
      '该逻辑文件没有任何可用副本记录，无法定位源文件（请先由收到文件的账号登记副本）',
      'blocked',
    );
  }

  private async describeFromCopies(
    ownerType: TelegramCopyOwnerType,
    ownerId: string,
    fallbackName: string,
  ): Promise<MirrorSourceDescriptor | null> {
    try {
      const ready = await this.copies.listReady(ownerType, ownerId);
      if (ready.length === 0) return null;
      const copy = ready[0];
      return {
        fileId: copy.telegramFileId,
        fileSize: Number(copy.fileSize ?? 0) || 0,
        fileName: fallbackName,
        chatId: copy.chatId ?? null,
        messageId: copy.messageId ?? null,
        sourceAccountId: copy.accountId,
        // 只知 file_unique_id 时无从得知覆盖版本：按首发版本处理
        sourceVersion: 1,
      };
    } catch (error) {
      this.logger.warn(`副本表查询失败（${ownerType}:${ownerId}）：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
