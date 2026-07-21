import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM recommended IV length
const VERSION_PREFIX_CBC = 'v1:';  // 旧格式: v1:ivHex:encryptedHex
const VERSION_PREFIX_GCM = 'v2:';  // 新格式: v2:ivHex:encryptedHex:authTagHex

/** 派生密钥缓存：避免每次加解密重复执行 scryptSync 同步阻塞事件循环 */
let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }
  const secret = process.env.SMTP_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('SMTP_ENCRYPTION_KEY 环境变量未配置，无法安全加密 SMTP 密码');
  }
  const salt = process.env.SMTP_ENCRYPTION_SALT;
  if (!salt) {
    throw new Error('SMTP_ENCRYPTION_SALT 环境变量未配置，请设置一个随机字符串作为加密盐值');
  }
  // 密钥来源于静态环境变量（运行期不变），缓存派生结果安全且显著降低 CPU/事件循环开销
  cachedKey = scryptSync(secret, salt, 32);
  return cachedKey;
}

/** 旧格式仅告警一次，避免高频解密时日志刷屏 */
let legacyFormatWarned = false;
function warnLegacyFormat(kind: string): void {
  if (legacyFormatWarned) return;
  legacyFormatWarned = true;
  console.warn(
    `[crypto] 检测到${kind}（无完整性校验，存在 Padding Oracle/注入风险），请尽快重新加密迁移至 AES-256-GCM (v2) 格式`,
  );
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
  // 安全提示：此分支直接返回原文，无完整性校验，若攻击者可写入存储则可绕过加密；
  // 仅为兼容历史数据保留，命中即告警，应尽快迁移至 GCM 格式
  if (!encrypted.includes(':')) {
    warnLegacyFormat('旧版明文密码');
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
  // ⚠️ 安全警告：AES-256-CBC 无完整性校验（无 HMAC/authTag），密文可被篡改且存在
  //   Padding Oracle 风险。理想方案是附加 HMAC 并校验，但历史 CBC 密文未存储 MAC，
  //   强行校验会破坏现有数据解密，故此处仅记录告警，提示尽快重新加密迁移至 GCM (v2)。
  warnLegacyFormat('旧版 AES-256-CBC 密文');
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
