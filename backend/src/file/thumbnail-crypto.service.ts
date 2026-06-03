import { Injectable, OnModuleInit } from '@nestjs/common';
import { generateKeyPairSync, privateDecrypt, constants } from 'crypto';

@Injectable()
export class ThumbnailCryptoService implements OnModuleInit {
  private publicKeyPem: string;
  private privateKeyPem: string;

  onModuleInit() {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 1024,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    this.publicKeyPem = publicKey;
    this.privateKeyPem = privateKey;
    console.log('[ThumbnailCrypto] RSA 密钥对已生成');
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
    return parseInt(decrypted.toString('utf8'), 10);
  }
}
