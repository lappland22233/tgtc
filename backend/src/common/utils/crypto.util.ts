import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-cbc';

function getKey(): Buffer {
  const secret = process.env.SMTP_ENCRYPTION_KEY || process.env.JWT_SECRET || 'smtp-encryption-key-change-me';
  return scryptSync(secret, 'smtp-encryption-salt', 32);
}

export function encryptPassword(plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

export function decryptPassword(encryptedWithIV: string): string {
  // 兼容旧格式：不含 ':' 的为明文（升级前存储的旧值）
  if (!encryptedWithIV.includes(':')) {
    return encryptedWithIV;
  }
  const [ivHex, encryptedHex] = encryptedWithIV.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
