import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const CIPHER_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * 账号凭据的可逆加密服务（AES-256-GCM）。
 *
 * 为什么必须独立于 `TelegramBotTokenCryptoService`：Bot 直链 Token 与账号池凭据
 * 的生命周期、轮换节奏与泄露影响面完全不同，共用根密钥会让一次密钥轮换同时影响
 * 两条链路。因此本服务使用**独立根密钥** `TELEGRAM_ACCOUNT_ENCRYPTION_KEY`。
 *
 * 降级路径（fail-closed，绝不落明文）：
 * - 根密钥不可用时 `encrypt` 返回 null，调用方必须**拒绝**创建/轮换账号并给出
 *   可操作提示（配置 32 字节 base64/hex 根密钥），而不是把明文写进数据库；
 * - `decrypt` 失败（密钥变更/密文损坏/版本不符）返回 null，调用方按「凭据不可用」
 *   把账号标记为 `degraded`，不抛出可泄露信息的异常。
 *
 * 任何日志、审计、异常与接口响应都不得出现根密钥材料或明文凭据。
 */
@Injectable()
export class TelegramAccountCredentialService {
  private readonly logger = new Logger(TelegramAccountCredentialService.name);
  private readonly rootKey: Buffer | null;
  private readonly available: boolean;

  constructor(private readonly configService: ConfigService) {
    const raw = (this.configService.get<string>('TELEGRAM_ACCOUNT_ENCRYPTION_KEY') || '').trim();
    this.rootKey = this.parseRootKey(raw);
    this.available = this.rootKey !== null;
    if (!this.available) {
      this.logger.warn(
        '未配置 TELEGRAM_ACCOUNT_ENCRYPTION_KEY（32 字节 base64/hex）：'
        + '账号凭据无法加密保存，账号创建与轮换将被拒绝（不会以明文落库）',
      );
    }
  }

  /** 当前是否可加密保存凭据（决定账号创建/轮换能否成功） */
  isAvailable(): boolean {
    return this.available;
  }

  /** 当前密文版本号（与 encrypt 输出前缀一致） */
  cipherVersion(): string {
    return CIPHER_VERSION;
  }

  /** 加密凭据载荷（JSON）；根密钥不可用时返回 null，调用方必须拒绝写入 */
  encryptCredential(payload: Record<string, unknown>): string | null {
    if (!this.rootKey) return null;
    try {
      return this.encryptText(JSON.stringify(payload));
    } catch {
      return null;
    }
  }

  /** 解密凭据载荷；密文/密钥不匹配时返回 null（不抛异常，避免信息泄露） */
  decryptCredential<T extends object>(cipherText: string | null | undefined): T | null {
    const plaintext = this.decryptText(cipherText);
    if (!plaintext) return null;
    try {
      const parsed = JSON.parse(plaintext) as T;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  private parseRootKey(raw: string): Buffer | null {
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

  private encryptText(plaintext: string): string {
    if (!this.rootKey) throw new Error('account_credential_key_unavailable');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.rootKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${CIPHER_VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  private decryptText(cipherText: string | null | undefined): string | null {
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
}
