import api from '../api/client';

let publicKey: CryptoKey | null = null;

/** PEM 转 ArrayBuffer */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** ArrayBuffer 转 base64url */
function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/** 获取并缓存公钥 */
async function getPublicKey(): Promise<CryptoKey> {
  if (publicKey) return publicKey;

  const res = await api.get('/files/public-key');
  const pem: string = res.data.data?.publicKey || res.data.publicKey;
  if (!pem) throw new Error('无法获取公钥');

  publicKey = await crypto.subtle.importKey(
    'spki',
    pemToArrayBuffer(pem),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  return publicKey;
}

/** 加密当前时间戳，返回 base64url 字符串 */
async function encryptTimestamp(): Promise<string> {
  const key = await getPublicKey();
  const encoder = new TextEncoder();
  const timestamp = Date.now().toString();
  const encrypted = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    key,
    encoder.encode(timestamp),
  );
  return arrayBufferToBase64Url(encrypted);
}

// ---- Token 缓存（带 TTL）----

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Token 复用窗口（毫秒），短于服务端 ±2s 容差以确保安全 */
const TOKEN_TTL = 1500;

let cachedToken: CachedToken | null = null;

/** 获取缩略图访问令牌（自动刷新，带 TTL 过期） */
export async function getThumbToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt) {
    return cachedToken.token;
  }
  // 超过 TTL 自动刷新
  const token = await encryptTimestamp();
  cachedToken = { token, expiresAt: now + TOKEN_TTL };
  return token;
}

/** 构建缩略图 URL */
export async function buildThumbUrl(fileId: string): Promise<string> {
  const token = await getThumbToken();
  return `/api/files/${fileId}/thumbnail?t=${token}`;
}

/** 清除缓存（路由切换时调用，防止 Token 跨页面复用） */
export function clearThumbToken() {
  cachedToken = null;
}
