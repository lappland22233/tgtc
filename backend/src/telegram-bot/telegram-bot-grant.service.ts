import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';
import { TelegramBotTokenCryptoService } from './telegram-bot-token-crypto.service';
import { BOT_TOKEN_PREFIX } from './telegram-bot.types';

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
  ): Promise<TelegramBotFileGrant | null> {
    return this.grantRepository.findOne({ where: { telegramUserId, chatId, messageId } });
  }

  /** 按 Token 查授权记录（含已过期/已撤销，供校验链判定） */
  async findByToken(token: string): Promise<TelegramBotFileGrant | null> {
    const tokenHash = this.hashToken(token);
    return this.grantRepository.findOne({ where: { tokenHash } });
  }

  /** 签发直链授权记录 */
  async issue(input: IssueGrantInput, ttlHours: number): Promise<IssuedGrant> {
    const token = this.generateToken();
    const tokenHash = this.hashToken(token);
    const tokenCipher = this.tokenCrypto.encrypt(token);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    const grant = this.grantRepository.create({
      telegramUserId: input.telegramUserId,
      telegramUsername: input.username,
      telegramDisplayName: input.displayName,
      chatId: input.chatId,
      messageId: input.messageId,
      telegramFileId: input.telegramFileId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
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

    const saved = await this.grantRepository.save(grant);
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
    grant.revokedAt = new Date();
    grant.revokedBy = revokedBy;
    await this.grantRepository.save(grant);
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

  /** 清理过期授权记录（保留已撤销记录用于审计追溯） */
  async purgeExpired(before: Date): Promise<number> {
    const result = await this.grantRepository.delete({ expiresAt: LessThan(before) });
    return result.affected ?? 0;
  }
}
