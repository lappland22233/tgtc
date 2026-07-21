import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { generateKeyPairSync, privateDecrypt, constants } from 'crypto';

@Injectable()
export class ThumbnailCryptoService implements OnModuleInit {
  private readonly logger = new Logger(ThumbnailCryptoService.name);
  private publicKeyPem: string;
  private privateKeyPem: string;

  onModuleInit() {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    this.publicKeyPem = publicKey;
    this.privateKeyPem = privateKey;
    this.logger.log('RSA 密钥对已生成');
  }

  getPublicKey(): string {
    return this.publicKeyPem;
  }

  /**
   * 解密客户端用公钥加密的时间戳（RSA-OAEP, SHA-256）
   * 返回 Unix 毫秒时间戳
   */
  decrypt(encryptedBase64Url: string): number {
    const buffer = Buffer.from(encryptedBase64Url, 'base64url');
    const decrypted = privateDecrypt(
      {
        key: this.privateKeyPem,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      buffer,
    );
    const timestamp = parseInt(decrypted.toString('utf8'), 10);
    // 非法明文会解析为 NaN；若不拦截，调用方的过期校验（NaN 比较恒为 false）会被绕过
    if (!Number.isFinite(timestamp)) {
      throw new Error('解密出的时间戳非法');
    }
    return timestamp;
  }
}
