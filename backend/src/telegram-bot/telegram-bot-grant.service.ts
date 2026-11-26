import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, LessThan, Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';
import { TelegramBotTokenCryptoService } from './telegram-bot-token-crypto.service';
import { BOT_TOKEN_PREFIX } from './telegram-bot.types';
import { GDRIVE_CACHE_LEASE_MS, gdriveCacheBackoffMs } from '../common/utils/gdrive-cache-backoff';

export interface IssueGrantInput {
  telegramUserId: string;
  username: string | null;
  displayName: string | null;
  chatId: string;
  messageId: string;
  telegramFileId: string;
  fileName: string | null;
  mimeType: string | null;
  fileSize: string | null;
  /**
   * 产生该 `file_id` 的 Bot 账号 ID（回退安全锚点）。
   * 池化模式为「收到消息的账号」；单账号模式为默认 Token 的 botId；无法确定时为 null。
   */
  sourceAccountId?: string | null;
  receiverBotId: string;
  /**
   * 内容标识 `file_unique_id`（可空）。
   *
   * 为什么记录：镜像群里的消息只携带 `file_unique_id`（跨账号稳定），认领归因需要
   * 用它反查 grant（群内消息不含私聊锚点）；历史/降级路径允许缺省。
   */
  fileUniqueId?: string | null;
  /** 存储后端：telegram (默认) | gdrive */
  storageBackend?: string;
  /** 存储账号 ID（非 TG 后端） */
  storageAccountId?: string | null;
  /** 远端对象引用（如 GDrive fileId） */
  storageObjectRef?: string | null;
  /**
   * Google 缓存状态：缓存模式开启时由签发路径在**同一事务内**写 'pending'。
   * 若等到回复后再置 pending，进程在两者之间崩溃会让该行永远停在 none、不再重试。
   */
  gdriveCacheStatus?: 'pending';
  /** Google 缓存首次重试时间（pending 时作为租约起点） */
  gdriveCacheNextRetryAt?: Date;
}

export interface IssuedGrant {
  grant: TelegramBotFileGrant;
  token: string;
}

/**
 * 直链签发与校验服务。
 *
 * Token 双轨存储（C-3）：`tokenHash`（校验）+ `tokenCipher`（管理员查询回放）。
 * 校验链仅时间限制（D2）：hash 命中 → 未撤销 → 未过期；不做次数拦截。
 */
@Injectable()
export class TelegramBotGrantService {
  private readonly logger = new Logger(TelegramBotGrantService.name);

  constructor(
    @InjectRepository(TelegramBotFileGrant)
    private readonly grantRepository: Repository<TelegramBotFileGrant>,
    private readonly tokenCrypto: TelegramBotTokenCryptoService,
  ) {}

  /** 生成 Token（≥32 字节随机，URL 安全） */
  generateToken(): string {
    return randomBytes(32).toString('base64url');
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Token 展示前缀（审计/管理查询用；绝不落完整 Token） */
  tokenPrefixOf(token: string): string {
    return `${BOT_TOKEN_PREFIX}${token.slice(0, 8)}`;
  }

  /** 按消息锚点查幂等记录（同一条消息重投时命中） */
  async findByMessage(
    telegramUserId: string,
    chatId: string,
    messageId: string,
    receiverBotId: string,
    telegramFileId: string,
  ): Promise<TelegramBotFileGrant | null> {
    const anchor = { telegramUserId, chatId, messageId };
    const scoped = await this.grantRepository.findOne({ where: { ...anchor, receiverBotId } });
    if (scoped) return scoped;
    // Historical sourceAccountId may be a reconfigured pool alias. A file_id is
    // scoped to its issuing Telegram bot and confirms ownership on redelivery.
    const legacy = await this.grantRepository.findOne({
      where: { ...anchor, receiverBotId: IsNull(), telegramFileId },
    });
    if (!legacy) return null;
    const claimed = await this.grantRepository.update({ id: legacy.id, receiverBotId: IsNull() }, { receiverBotId });
    if (claimed.affected) return Object.assign(legacy, { receiverBotId });
    return this.grantRepository.findOne({ where: { ...anchor, receiverBotId } });
  }

  /** 按 Token 查授权记录（含已过期/已撤销，供校验链判定） */
  async findByToken(token: string): Promise<TelegramBotFileGrant | null> {
    const tokenHash = this.hashToken(token);
    return this.grantRepository.findOne({ where: { tokenHash } });
  }

  findById(id: string): Promise<TelegramBotFileGrant | null> {
    return this.grantRepository.findOneBy({ id });
  }

  /**
   * 按内容标识查 grant（跨群认领归因：群内消息只带 file_unique_id）。
   * 按签发时间倒序取最近若干条。
   */
  async findByFileUniqueId(fileUniqueId: string, limit = 5): Promise<TelegramBotFileGrant[]> {
    const unique = (fileUniqueId || '').trim();
    // 空串/空白串直接返回：绝不拿空串查库（否则会把 fileUniqueId 为空的历史行全部命中）
    if (!unique) return [];
    return this.grantRepository.find({
      where: { fileUniqueId: unique },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /** 签发直链授权记录 */
  async issue(input: IssueGrantInput, ttlHours: number, manager?: EntityManager, taskId?: string): Promise<IssuedGrant> {
    const repository = manager?.getRepository(TelegramBotFileGrant) ?? this.grantRepository;
    const token = taskId && !this.tokenCrypto.isAvailable()
      ? this.tokenCrypto.deriveQueuedToken(taskId)
      : this.generateToken();
    const tokenHash = this.hashToken(token);
    const tokenCipher = this.tokenCrypto.encrypt(token);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    const grant = repository.create({
      telegramUserId: input.telegramUserId,
      telegramUsername: input.username,
      telegramDisplayName: input.displayName,
      chatId: input.chatId,
      receiverBotId: input.receiverBotId,
      messageId: input.messageId,
      telegramFileId: input.telegramFileId,
      // 内容标识（可空）：把群内认领归因回该 grant 的索引键；缺省时保持 NULL（向后兼容）
      fileUniqueId: input.fileUniqueId ?? null,
      sourceAccountId: input.sourceAccountId ?? null,
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
      storageBackend: input.storageBackend ?? 'telegram',
      storageAccountId: input.storageAccountId ?? null,
      storageObjectRef: input.storageObjectRef ?? null,
      storagePurgedAt: null,
      gdriveCacheStatus: input.gdriveCacheStatus ?? 'none',
      gdriveCacheAttempts: 0,
      gdriveCacheLastError: null,
      gdriveCacheNextRetryAt: input.gdriveCacheNextRetryAt ?? null,
      tokenHash,
      tokenCipher,
      tokenPrefix: this.tokenPrefixOf(token),
      cipherVersion: tokenCipher ? this.tokenCrypto.cipherVersion() : null,
      expiresAt,
      revokedAt: null,
      revokedBy: null,
      accessCount: 0,
      lastAccessedAt: null,
    });

    const saved = await repository.save(grant);
    return { grant: saved, token };
  }

  /** 构建完整直链 URL */
  buildUrl(origin: string, token: string): string {
    const base = origin.replace(/\/+$/, '');
    return `${base}/api/bot-dl/${token}`;
  }

  /** 判定授权是否有效（未撤销且未过期） */
  isActive(grant: TelegramBotFileGrant, now: Date = new Date()): boolean {
    if (grant.revokedAt) return false;
    return new Date(grant.expiresAt).getTime() > now.getTime();
  }

  /** 回放完整 Token（密文缺失/解密失败返回 null，调用方降级为仅前缀） */
  replayToken(grant: TelegramBotFileGrant): string | null {
    if (!grant.tokenCipher) return null;
    return this.tokenCrypto.decrypt(grant.tokenCipher);
  }

  tokenForQueuedNotice(grant: TelegramBotFileGrant, taskId: string): string | null {
    if (grant.tokenCipher) return this.replayToken(grant);
    const token = this.tokenCrypto.deriveQueuedToken(taskId);
    return this.hashToken(token) === grant.tokenHash ? token : null;
  }

  /** 查询某 TG 用户当前有效的直链（未过期未撤销） */
  async listActiveByUser(telegramUserId: string): Promise<TelegramBotFileGrant[]> {
    const list = await this.grantRepository.find({
      where: {
        telegramUserId,
        revokedAt: IsNull(),
      },
      order: { createdAt: 'DESC' },
    });
    return list.filter((g) => this.isActive(g));
  }

  /** 软撤销（立即失效）；已撤销时返回 false（幂等） */
  async revoke(grant: TelegramBotFileGrant, revokedBy: string): Promise<boolean> {
    if (grant.revokedAt) return false;
    const fields = { revokedAt: new Date(), revokedBy };
    const result = await this.grantRepository.update({ id: grant.id, revokedAt: IsNull() }, fields);
    if (!result.affected) return false;
    Object.assign(grant, fields);
    return true;
  }

  /**
   * 记录访问（仅供统计，D2；任何失败都不得影响下载链路）。
   * 使用原子自增，避免并发丢失计数。
   */
  async recordAccess(grantId: string): Promise<void> {
    try {
      await this.grantRepository.increment({ id: grantId }, 'accessCount', 1);
      await this.grantRepository.update({ id: grantId }, { lastAccessedAt: new Date() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`直链访问计数写入失败（忽略）: ${message}`);
    }
  }

  /** 更新 Google 缓存副本信息 */
  async attachGDriveCache(grantId: string, accountId: string | null | undefined, objectRef: string): Promise<boolean> {
    const updateResult = await this.grantRepository.update(
      {
        id: grantId,
        revokedAt: IsNull(),
        storagePurgedAt: IsNull(),
      },
      {
        gdriveCacheAccountId: accountId ?? null,
        gdriveCacheObjectRef: objectRef,
        gdriveCacheStatus: 'ready',
        gdriveCacheAttempts: 0,
        gdriveCacheLastError: null,
        gdriveCacheNextRetryAt: null,
      },
    );
    return (updateResult.affected ?? 0) > 0;
  }

  /**
   * 抢占一次 Google 缓存同步（原子 CAS）。
   *
   * 命中后写入 10 分钟租约（`gdriveCacheNextRetryAt`）：同一行在租约内不会被
   * 再次触发；进程崩溃导致租约过期后，扫描任务会重新接管。
   */
  async markGDriveCachePending(grantId: string): Promise<boolean> {
    const now = new Date();
    const result = await this.grantRepository
      .createQueryBuilder()
      .update(TelegramBotFileGrant)
      .set({
        gdriveCacheStatus: 'pending',
        gdriveCacheNextRetryAt: new Date(now.getTime() + GDRIVE_CACHE_LEASE_MS),
      })
      .where('id = :id', { id: grantId })
      .andWhere('"storagePurgedAt" IS NULL')
      .andWhere('("gdriveCacheStatus" IS NULL OR "gdriveCacheStatus" IN (:...statuses))', {
        statuses: ['none', 'pending', 'failed'],
      })
      .andWhere('("gdriveCacheNextRetryAt" IS NULL OR "gdriveCacheNextRetryAt" <= :now)', { now })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  /** 上传期间续期：仅当仍在 pending 时把租约推到下一个完整窗口（不复活已 ready/failed 的行） */
  async renewGDriveCacheLease(grantId: string): Promise<void> {
    await this.grantRepository
      .createQueryBuilder()
      .update(TelegramBotFileGrant)
      .set({ gdriveCacheNextRetryAt: new Date(Date.now() + GDRIVE_CACHE_LEASE_MS) })
      .where('id = :id', { id: grantId })
      .andWhere('"gdriveCacheStatus" = :status', { status: 'pending' })
      .execute();
  }

  /** 记录一次缓存同步失败：次数 +1、写原因、按指数退避安排下次重试 */
  async markGDriveCacheFailed(grantId: string, error: unknown, attempts = 1): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      await this.grantRepository
        .createQueryBuilder()
        .update(TelegramBotFileGrant)
        .set({
          gdriveCacheStatus: 'failed',
          gdriveCacheLastError: (detail || 'unknown').slice(0, 500),
          gdriveCacheNextRetryAt: new Date(Date.now() + gdriveCacheBackoffMs(attempts)),
          gdriveCacheAttempts: () => '"gdriveCacheAttempts" + 1',
        })
        .where('id = :id', { id: grantId })
        .execute();
    } catch (err) {
      this.logger.warn(`记录 Google 缓存失败状态时出错（忽略）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 到期待重试的 Bot 直链（仅 pending/failed；不回填历史 none） */
  async findDueGDriveCacheMirrors(limit = 5): Promise<TelegramBotFileGrant[]> {
    return this.dueGDriveCacheQuery().orderBy('grant.gdriveCacheNextRetryAt', 'ASC').limit(limit).getMany();
  }

  /** 到期重试积压量（供告警判定） */
  async countDueGDriveCacheMirrors(): Promise<number> {
    return this.dueGDriveCacheQuery().getCount();
  }

  private dueGDriveCacheQuery() {
    const now = new Date();
    return this.grantRepository
      .createQueryBuilder('grant')
      .where('grant.storageBackend = :backend', { backend: 'telegram' })
      .andWhere('grant.storagePurgedAt IS NULL')
      .andWhere('grant.revokedAt IS NULL')
      .andWhere('grant.expiresAt > :now', { now })
      .andWhere('grant.gdriveCacheStatus IN (:...statuses)', { statuses: ['pending', 'failed'] })
      .andWhere('(grant.gdriveCacheNextRetryAt IS NULL OR grant.gdriveCacheNextRetryAt <= :now)', { now });
  }

  /** 清理过期授权记录（保留已撤销记录用于审计追溯） */
  async purgeExpired(before: Date): Promise<number> {
    const result = await this.grantRepository.delete({ expiresAt: LessThan(before) });
    return result.affected ?? 0;
  }
}
