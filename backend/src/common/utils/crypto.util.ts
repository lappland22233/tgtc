import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM recommended IV length
const VERSION_PREFIX_CBC = 'v1:';  // 旧格式: v1:ivHex:encryptedHex
const VERSION_PREFIX_GCM = 'v2:';  // 新格式: v2:ivHex:encryptedHex:authTagHex

function getKey(): Buffer {
  const secret = process.env.SMTP_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('SMTP_ENCRYPTION_KEY 环境变量未配置，无法安全加密 SMTP 密码');
  }
  const salt = process.env.SMTP_ENCRYPTION_SALT;
  if (!salt) {
    throw new Error('SMTP_ENCRYPTION_SALT 环境变量未配置，请设置一个随机字符串作为加密盐值');
  }
  return scryptSync(secret, salt, 32);
}

/** 使用 AES-256-GCM 加密 */
export function encryptPassword(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${VERSION_PREFIX_GCM}${iv.toString('hex')}:${encrypted.toString('hex')}:${authTag.toString('hex')}`;
}

/** 解密（兼容旧版 AES-256-CBC 格式） */
export function decryptPassword(encrypted: string): string {
  // 完全无分隔符 = 旧版明文（迁移前存储的值，目前已不应存在）
  if (!encrypted.includes(':')) {
    return encrypted;
  }

  // GCM 当前格式: v2:iv:encrypted:authTag
  if (encrypted.startsWith(VERSION_PREFIX_GCM)) {
    const payload = encrypted.slice(VERSION_PREFIX_GCM.length);
    const [ivHex, encryptedHex, authTagHex] = payload.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encryptedData = Buffer.from(encryptedHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    return decrypted.toString('utf8');
  }

  // CBC 旧格式: iv:encrypted 或 v1:iv:encrypted
  const payload = encrypted.startsWith(VERSION_PREFIX_CBC)
    ? encrypted.slice(VERSION_PREFIX_CBC.length)
    : encrypted;
  const [ivHex, encryptedHex] = payload.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedData = Buffer.from(encryptedHex, 'hex');
  const decipher = createDecipheriv('aes-256-cbc', getKey(), iv);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  return decrypted.toString('utf8');
}
