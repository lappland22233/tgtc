import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const CIPHER_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Bot 直链 Token 的可逆加密服务（AES-256-GCM）。
 *
 * 与 `ApiKeyCryptoService` 同构但**独立**：`ApiKeyModule` 未导出其 crypto 服务
 * 且未标 @Global（C-4），为避免扩大导出面，这里使用独立根密钥
 * `TELEGRAM_BOT_ENCRYPTION_KEY`。
 *
 * 降级路径（必须）：未配置根密钥时 `encrypt` 返回 null，管理员查询只能返回
 * 元信息 + 前缀，并明确提示“未启用加密存储，无法回放完整链接”（R9）。
 * 任何日志/异常均不得输出密钥材料或明文 Token。
 */
@Injectable()
export class TelegramBotTokenCryptoService {
  private readonly logger = new Logger(TelegramBotTokenCryptoService.name);
  private rootKey: Buffer | null = null;
  private readonly available: boolean;

  constructor(private readonly configService: ConfigService) {
    const raw = this.configService.get<string>('TELEGRAM_BOT_ENCRYPTION_KEY')?.trim();
    this.rootKey = this.parseRootKey(raw);
    this.available = this.rootKey !== null;
    if (!this.available) {
      this.logger.warn(
        '未配置 TELEGRAM_BOT_ENCRYPTION_KEY（32 字节 base64/hex）：Bot 直链 Token 将以不可回放模式保存，'
        + '/link_query 仅能返回前缀',
      );
    }
  }

  /** 当前是否可加密保存（决定 /link_query 是否可回放完整链接） */
  isAvailable(): boolean {
    return this.available;
  }

  private parseRootKey(raw: string | undefined): Buffer | null {
    if (!raw) return null;
    try {
      if (/^[0-9a-fA-F]{64}$/.test(raw)) {
        const buf = Buffer.from(raw, 'hex');
        return buf.length === KEY_BYTES ? buf : null;
      }
      const buf = Buffer.from(raw, 'base64');
      return buf.length === KEY_BYTES ? buf : null;
    } catch {
      return null;
    }
  }

  /** 加密 Token；根密钥不可用时返回 null（以不可回放模式保存） */
  encrypt(plaintext: string): string | null {
    if (!this.rootKey) return null;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.rootKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${CIPHER_VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  /** 解密密文；格式/密钥不匹配时返回 null（不抛异常，避免错误信息泄露） */
  decrypt(cipherText: string | null | undefined): string | null {
    if (!cipherText || !this.rootKey) return null;
    const parts = cipherText.split(':');
    if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) return null;
    try {
      const iv = Buffer.from(parts[1], 'base64');
      const tag = Buffer.from(parts[2], 'base64');
      const ciphertext = Buffer.from(parts[3], 'base64');
      const decipher = createDecipheriv(ALGORITHM, this.rootKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  /** 当前密文版本号（与 encrypt 输出前缀一致） */
  cipherVersion(): string {
    return CIPHER_VERSION;
  }
}
