import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { ApiKeyCryptoService } from './api-key-crypto.service';

/**
 * B-13：API 密钥加解密此前零直接测试。
 *
 * 这是「所有者重显完整明文」的唯一通道，安全要求：
 * 认证只用 SHA-256 keyHash，密文绝不参与认证；根密钥缺失时降级为不可重显；
 * 任何格式/密钥/认证标签不匹配都必须静默返回 null，不得抛异常泄漏信息。
 */
function makeService(key?: string) {
  const config = { get: jest.fn((name: string) => (name === 'API_KEY_ENCRYPTION_KEY' ? key : undefined)) };
  return new ApiKeyCryptoService(config as any);
}

const base64Key = randomBytes(32).toString('base64');
const hexKey = randomBytes(32).toString('hex');

describe('ApiKeyCryptoService 根密钥解析', () => {
  it('未配置根密钥时降级为不可重显，且不抛异常', () => {
    const service = makeService(undefined);
    expect(service.isAvailable()).toBe(false);
    expect(service.encrypt('tgk_secret')).toBeNull();
    expect(service.decrypt('v1:a:b:c')).toBeNull();
  });

  it.each(['', '   ', 'not-a-key', 'short'])('非法根密钥 %s 一律降级为不可用', (raw) => {
    expect(makeService(raw).isAvailable()).toBe(false);
  });

  it('16 字节密钥长度不足 → 不可用（AES-256 需要 32 字节）', () => {
    expect(makeService(randomBytes(16).toString('base64')).isAvailable()).toBe(false);
  });

  it('base64 与 hex 两种编码都被接受', () => {
    expect(makeService(base64Key).isAvailable()).toBe(true);
    expect(makeService(hexKey).isAvailable()).toBe(true);
  });

  it('首尾空白被裁剪后仍可解析', () => {
    expect(makeService(`  ${base64Key}  `).isAvailable()).toBe(true);
  });
});

describe('ApiKeyCryptoService 加解密', () => {
  it('round-trip 还原明文（含非 ASCII）', () => {
    const service = makeService(base64Key);
    const plaintext = 'tgk_拉普兰德_0123456789abcdef';
    const cipher = service.encrypt(plaintext);
    expect(cipher).toBeTruthy();
    expect(service.decrypt(cipher)).toBe(plaintext);
  });

  it('密文不得包含明文子串', () => {
    const service = makeService(base64Key);
    const plaintext = 'tgk_super_secret_value';
    expect(service.encrypt(plaintext)).not.toContain(plaintext);
  });

  it('同一明文两次加密产生不同密文（随机 IV，非确定性加密）', () => {
    const service = makeService(base64Key);
    expect(service.encrypt('same')).not.toBe(service.encrypt('same'));
  });

  it('密文格式为 v1:iv:tag:ciphertext 四段', () => {
    const cipher = makeService(base64Key).encrypt('x')!;
    const parts = cipher.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
  });

  it.each([
    ['空字符串', ''],
    ['段数不足', 'v1:abc:def'],
    ['段数过多', 'v1:a:b:c:d'],
    ['版本不匹配', 'v2:a:b:c'],
    ['非法 base64 内容', 'v1:!!!:###:$$$'],
  ])('%s 的密文解密返回 null，不抛异常', (_label, cipher) => {
    expect(makeService(base64Key).decrypt(cipher)).toBeNull();
  });

  it('篡改密文体 → GCM 认证失败返回 null', () => {
    const service = makeService(base64Key);
    const parts = service.encrypt('tgk_secret')!.split(':');
    const body = Buffer.from(parts[3], 'base64');
    body[0] ^= 0xff;
    parts[3] = body.toString('base64');
    expect(service.decrypt(parts.join(':'))).toBeNull();
  });

  it('篡改认证标签 → 返回 null', () => {
    const service = makeService(base64Key);
    const parts = service.encrypt('tgk_secret')!.split(':');
    const tag = Buffer.from(parts[2], 'base64');
    tag[0] ^= 0xff;
    parts[2] = tag.toString('base64');
    expect(service.decrypt(parts.join(':'))).toBeNull();
  });

  it('换根密钥后旧密文解不开（密钥隔离）', () => {
    const cipher = makeService(base64Key).encrypt('tgk_secret');
    expect(makeService(randomBytes(32).toString('base64')).decrypt(cipher)).toBeNull();
  });

  it.each([null, undefined, ''])('空输入 %s 解密返回 null', (value) => {
    expect(makeService(base64Key).decrypt(value as any)).toBeNull();
  });

  it('hex 根密钥与 base64 根密钥指向同一密钥时密文互通', () => {
    const key = randomBytes(32);
    const a = makeService(key.toString('base64'));
    const b = makeService(key.toString('hex'));
    expect(b.decrypt(a.encrypt('tgk_secret'))).toBe('tgk_secret');
  });
});