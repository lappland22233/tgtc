import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const CIPHER_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * API 密钥加密服务（v1.2.6）。
 *
 * - AES-256-GCM 可逆加密，仅用于「所有者重显完整明文」场景；
 * - 认证仍使用 SHA-256 keyHash，密文绝不参与认证；
 * - 根密钥来自环境变量 API_KEY_ENCRYPTION_KEY（32 字节，base64 或 hex 编码），
 *   启动时校验格式；未配置时新密钥以「不可重显」模式创建（与历史行为一致），
 *   已有密文不受影响；
 * - 任何日志/异常均不得输出密钥材料或明文。
 */
@Injectable()
export class ApiKeyCryptoService {
  private readonly logger = new Logger(ApiKeyCryptoService.name);
  private rootKey: Buffer | null = null;
  private readonly available: boolean;

  constructor(private readonly configService: ConfigService) {
    const raw = this.configService.get<string>('API_KEY_ENCRYPTION_KEY')?.trim();
    this.rootKey = this.parseRootKey(raw);
    this.available = this.rootKey !== null;
    if (!this.available) {
      this.logger.warn(
        '未配置 API_KEY_ENCRYPTION_KEY（32 字节 base64/hex）：新建 API 密钥将无法在界面重显明文，仅保留前缀识别',
      );
    }
  }

  /** 当前是否可加密保存（决定新密钥是否可重显） */
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

  /** 加密明文密钥；根密钥不可用时返回 null（密钥以不可重显模式保存） */
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
}
