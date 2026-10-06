import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelegramAccountPoolService } from '../telegram-account-pool/telegram-account-pool.service';
import { File } from '../common/entities/file.entity';
import { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';
import { FileCopyService } from '../telegram-account-pool/file-copy.service';
import { TelegramCopyOwnerType, TelegramFileCopy } from '../common/entities/telegram-file-copy.entity';
import { MirrorExecutionError } from './telegram-mirror.errors';

/**
 * 副本锚点能否用于补齐源定位（本函数只校验锚点与大小，不校验内容身份）。
 *
 * 站内文件的镜像源回退必须先按 `fileUnique:<telegramFileUniqueId>` 精确查询候选；
 * 大小只作额外的旧版本保护，绝不能单独用相同大小推断内容相同。其它调用方也必须
 * 先通过归属查询保证候选属于对应逻辑文件。副本行没有内容版本列，覆盖上传后可能
 * 残留旧行，因此双方大小都已知时要求一致；宁可阻塞，也不从中继旧内容。
 */
export function isUsableSourceCopyAnchor(
  fileSize: number | null | undefined,
  copy: Pick<TelegramFileCopy, 'chatId' | 'messageId' | 'fileSize'>,
): boolean {
  const chatId = (copy.chatId ?? '').trim();
  const messageId = (copy.messageId ?? '').trim();
  if (!chatId || !messageId) return false;

  const copySize = copy.fileSize === null || copy.fileSize === undefined || String(copy.fileSize).trim() === ''
    ? null
    : Number(copy.fileSize);
  const knownFileSize = fileSize === null || fileSize === undefined ? null : Number(fileSize);
  // 至少一方大小未知时视为可用（无法做版本比对，但锚点本身可信）；
  // 双方都已知时必须严格一致，否则视为旧版本残留。
  if (copySize === null || knownFileSize === null) return true;
  return copySize === knownFileSize;
}

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
 * - `file`：站内文件（普通 Web 上传）——优先读 `files` 主副本定位字段；异常回退按其
 *   `telegramFileUniqueId` 精确查 `fileUnique` ready 副本；
 * - `grant`：Bot 私聊入站文件——读 `telegram_bot_file_grants` 的 chat/message/file_id；
 * - `fileUnique`：仅知跨账号稳定的 `file_unique_id`——从对应身份的 ready 副本取源。
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
    private readonly pool: TelegramAccountPoolService,
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
    // 源定位与 file_id 都完整：直接返回（热路径不触达副本表）
    if (descriptor.fileId && descriptor.chatId && descriptor.messageId) return descriptor;

    // 异常回退必须先有主记录当前内容的稳定身份；旧 file 归属副本不含身份，
    // 即使大小相等也无法证明是当前内容，因此只按 file_unique_id 查 fileUnique 副本。
    const fileUniqueId = file.telegramFileUniqueId?.trim();
    if (!fileUniqueId) {
      if (!descriptor.fileId) {
        throw new MirrorExecutionError(
          'source_copy_identity_unresolved',
          '主副本 file_id 与 file_unique_id 均缺失，无法验证任何副本是否对应当前内容',
          'blocked',
        );
      }
      return descriptor;
    }
    const activePoolAccountIds = this.activePoolAccountIds();
    const fromCopies = await this.describeFromCopies(
      'fileUnique',
      fileUniqueId,
      descriptor.fileName,
      file.size ?? null,
      activePoolAccountIds,
    );
    if (!fromCopies) {
      if (!descriptor.fileId) {
        throw new MirrorExecutionError(
          'source_copy_identity_unresolved',
          '主副本 file_id 缺失，且没有当前 file_unique_id 对应的可用 ready 副本',
          'blocked',
        );
      }
      return descriptor;
    }

    // 主记录仍有 file_id 时只补源锚点；锚点所属账号随副本一起更新，禁止跨账号代搬。
    if (descriptor.fileId) {
      return {
        ...descriptor,
        chatId: fromCopies.chatId,
        messageId: fromCopies.messageId,
        sourceAccountId: fromCopies.sourceAccountId,
      };
    }

    // 主记录 file_id 缺失时才使用匹配身份的副本；任务版本始终以主记录 uploadVersion 为准。
    return { ...fromCopies, sourceVersion: descriptor.sourceVersion };
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
    const activePoolAccountIds = this.activePoolAccountIds();
    const fromCopies = await this.describeFromCopies(
      'fileUnique', ownerId, 'mirror-backup', undefined, activePoolAccountIds,
    );
    if (fromCopies) return fromCopies;
    throw new MirrorExecutionError(
      'no_source_copy',
      '该逻辑文件没有任何可用副本记录，无法定位源文件（请先由收到文件的账号登记副本）',
      'blocked',
    );
  }

  /** 池化激活时捕获当前可调度 Bot；每次异常回退只读取一份运行快照。 */
  private activePoolAccountIds(): Set<string> | null {
    if (!this.pool.isActive()) return null;
    return new Set(
      this.pool.snapshot().accounts
        .filter((account) => account.enabled && account.storageConfigured)
        .map((account) => account.id),
    );
  }

  /** 从本次账号池快照中选择仍可执行并配置存储 Chat 的源 Bot。 */
  private pickEnabledSourceCopy(
    copies: TelegramFileCopy[],
    activePoolAccountIds: Set<string> | null,
  ): TelegramFileCopy | null {
    if (copies.length === 0) return null;
    if (!activePoolAccountIds) return copies[0] ?? null;
    return copies.find((copy) => activePoolAccountIds.has(copy.accountId)) ?? null;
  }

  private async describeFromCopies(
    ownerType: TelegramCopyOwnerType,
    ownerId: string,
    fallbackName: string,
    /**
     * 已知的文件大小（只有 `file` 归属可知），用于过滤旧版本残留副本；
     * `undefined` = 无从比对（`fileUnique` 只知 `file_unique_id`），保持原行为。
     */
    knownFileSize?: number | null,
    activePoolAccountIds: Set<string> | null = null,
  ): Promise<MirrorSourceDescriptor | null> {
    try {
      const ready = await this.copies.listReady(ownerType, ownerId);
      if (ready.length === 0) return null;
      const usable = knownFileSize === undefined
        ? ready
        : ready.filter((item) => isUsableSourceCopyAnchor(knownFileSize, item));
      const copy = this.pickEnabledSourceCopy(usable, activePoolAccountIds);
      if (!copy) return null;
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
