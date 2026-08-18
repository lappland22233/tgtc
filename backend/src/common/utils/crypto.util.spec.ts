import { encryptPassword, decryptPassword, isLegacyEncrypted } from './crypto.util';

describe('crypto.util (G9-12)', () => {
  const oldKey = process.env.SMTP_ENCRYPTION_KEY;
  const oldSalt = process.env.SMTP_ENCRYPTION_SALT;

  beforeAll(() => {
    process.env.SMTP_ENCRYPTION_KEY = 'test-secret-key-for-g912';
    process.env.SMTP_ENCRYPTION_SALT = 'test-salt';
  });

  afterAll(() => {
    if (oldKey === undefined) delete process.env.SMTP_ENCRYPTION_KEY;
    else process.env.SMTP_ENCRYPTION_KEY = oldKey;
    if (oldSalt === undefined) delete process.env.SMTP_ENCRYPTION_SALT;
    else process.env.SMTP_ENCRYPTION_SALT = oldSalt;
  });

  it('round-trips v2 GCM encrypt/decrypt', () => {
    const enc = encryptPassword('secret');
    expect(enc.startsWith('v2:')).toBe(true);
    expect(decryptPassword(enc)).toBe('secret');
  });

  it('isLegacyEncrypted: v2 is not legacy, CBC/plaintext are legacy', () => {
    expect(isLegacyEncrypted(encryptPassword('x'))).toBe(false);
    expect(isLegacyEncrypted('some-plain-text')).toBe(true); // 无 ':' 明文
    expect(isLegacyEncrypted('v1:00112233445566778899aabbccddeeff:deadbeef')).toBe(true); // CBC v1
    expect(isLegacyEncrypted('00112233445566778899aabbccddeeff:deadbeef')).toBe(true); // CBC
    expect(isLegacyEncrypted('')).toBe(false);
  });

  it('legacy CBC value decrypts (compat path) and is flagged legacy', () => {
    // 手动构造一个 CBC 密文用于验证兼容解密分支仍可用
    const crypto = require('crypto');
    const key = crypto.scryptSync(process.env.SMTP_ENCRYPTION_KEY!, process.env.SMTP_ENCRYPTION_SALT!, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const enc = Buffer.concat([cipher.update('legacy-value', 'utf8'), cipher.final()]);
    const cbcValue = `${iv.toString('hex')}:${enc.toString('hex')}`;
    expect(isLegacyEncrypted(cbcValue)).toBe(true);
    expect(decryptPassword(cbcValue)).toBe('legacy-value');
  });
});
