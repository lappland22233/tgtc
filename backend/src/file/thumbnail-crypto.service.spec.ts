import 'reflect-metadata';
import { publicEncrypt, constants, randomBytes } from 'crypto';
import { ThumbnailCryptoService } from './thumbnail-crypto.service';

/**
 * B-13：缩略图时间戳加解密此前零直接测试。
 *
 * 最关键的安全不变量：解密出的明文必须是有限数字。非法明文会 parseInt 成 NaN，
 * 而调用方的过期校验是 `now - ts > ttl` 之类比较 —— NaN 参与比较恒为 false，
 * 等于过期校验被静默绕过。
 */
function makeService(): ThumbnailCryptoService {
  const service = new ThumbnailCryptoService();
  service.onModuleInit();
  return service;
}

function encryptWith(publicKeyPem: string, plaintext: string): string {
  return publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(plaintext, 'utf8'),
  ).toString('base64url');
}

describe('ThumbnailCryptoService（B-13）', () => {
  it('onModuleInit 生成 SPKI PEM 公钥', () => {
    const service = makeService();
    expect(service.getPublicKey()).toContain('BEGIN PUBLIC KEY');
  });

  it('round-trip 还原 Unix 毫秒时间戳', () => {
    const service = makeService();
    const ts = Date.now();
    expect(service.decrypt(encryptWith(service.getPublicKey(), String(ts)))).toBe(ts);
  });

  it.each([
    ['非数字明文', 'not-a-number'],
    ['空明文', ''],
    ['纯空白', '   '],
    ['混合前缀数字', 'abc123'],
  ])('%s 必须抛错，不得返回 NaN 绕过过期校验', (_label, plaintext) => {
    const service = makeService();
    expect(() => service.decrypt(encryptWith(service.getPublicKey(), plaintext))).toThrow();
  });

  it('前缀数字后跟垃圾字符时只取前缀（parseInt 语义），仍为有限数', () => {
    const service = makeService();
    // '123abc' → 123；调用方按时间戳处理，不是 NaN 绕过
    expect(service.decrypt(encryptWith(service.getPublicKey(), '123abc'))).toBe(123);
  });

  it('0 与负数是有限数，原样返回交由调用方判过期', () => {
    const service = makeService();
    expect(service.decrypt(encryptWith(service.getPublicKey(), '0'))).toBe(0);
    expect(service.decrypt(encryptWith(service.getPublicKey(), '-1'))).toBe(-1);
  });

  it('篡改密文 → 抛错（OAEP 完整性）', () => {
    const service = makeService();
    const cipher = encryptWith(service.getPublicKey(), String(Date.now()));
    const buf = Buffer.from(cipher, 'base64url');
    buf[10] ^= 0xff;
    expect(() => service.decrypt(buf.toString('base64url'))).toThrow();
  });

  it('随机字节冒充密文 → 抛错', () => {
    const service = makeService();
    expect(() => service.decrypt(randomBytes(256).toString('base64url'))).toThrow();
  });

  it('空字符串输入 → 抛错', () => {
    expect(() => makeService().decrypt('')).toThrow();
  });

  it('另一实例的公钥加密的密文解不开（密钥对进程内独立）', () => {
    const a = makeService();
    const b = makeService();
    expect(a.getPublicKey()).not.toBe(b.getPublicKey());
    expect(() => b.decrypt(encryptWith(a.getPublicKey(), String(Date.now())))).toThrow();
  });

  it('同一实例多次解密结果稳定', () => {
    const service = makeService();
    const cipher = encryptWith(service.getPublicKey(), '1700000000000');
    expect(service.decrypt(cipher)).toBe(1700000000000);
    expect(service.decrypt(cipher)).toBe(1700000000000);
  });
});