import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

export type MediaTicketScope = 'user' | 'share';

export interface MediaTicketPayload {
  fileId: string;
  uploadVersion: number;
  subject: string;
  scope: MediaTicketScope;
  purpose: 'preview';
  iat: number;
  exp: number;
  nonce: string;
}

@Injectable()
export class MediaTicketService {
  private static readonly DEFAULT_TTL_SECONDS = 5 * 60;

  constructor(private readonly configService: ConfigService) {}

  issue(input: Omit<MediaTicketPayload, 'iat' | 'exp' | 'nonce'>, ttlSeconds = MediaTicketService.DEFAULT_TTL_SECONDS): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: MediaTicketPayload = {
      ...input,
      iat: now,
      exp: now + Math.max(1, Math.floor(ttlSeconds)),
      nonce: randomBytes(18).toString('base64url'),
    };
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return `${iv.toString('base64url')}.${encrypted.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  }

  verify(ticket: string): MediaTicketPayload {
    const parts = ticket.split('.');
    if (parts.length !== 3 || parts.some((part) => !part)) this.invalid();

    let payload: MediaTicketPayload;
    try {
      const [ivPart, encryptedPart, tagPart] = parts;
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivPart, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(encryptedPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
      payload = JSON.parse(plain);
    } catch {
      this.invalid();
    }

    const now = Math.floor(Date.now() / 1000);
    if (!payload || payload.purpose !== 'preview' || (payload.scope !== 'user' && payload.scope !== 'share')
      || typeof payload.fileId !== 'string' || !payload.fileId
      || typeof payload.uploadVersion !== 'number' || !Number.isInteger(payload.uploadVersion)
      || typeof payload.subject !== 'string' || !payload.subject
      || typeof payload.nonce !== 'string' || !payload.nonce
      || typeof payload.iat !== 'number' || typeof payload.exp !== 'number'
      || payload.iat > now + 60 || payload.exp <= now || payload.exp <= payload.iat) {
      this.invalid();
    }
    return payload;
  }

  private get key(): Buffer {
    // SHA-256 将任意长度的专用密钥规范化为 AES-256 所需的 32 字节密钥。
    return createHash('sha256').update(this.secret).digest();
  }

  private get secret(): string {
    const secret = this.configService.get<string>('MEDIA_TICKET_SECRET') || this.configService.get<string>('JWT_SECRET');
    if (!secret) throw new Error('MEDIA_TICKET_SECRET 或 JWT_SECRET 环境变量未配置');
    return secret;
  }

  private invalid(): never {
    throw new UnauthorizedException('媒体票据无效或已过期');
  }
}
