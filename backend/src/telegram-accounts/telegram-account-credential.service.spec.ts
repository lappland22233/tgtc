import { ConfigService } from '@nestjs/config';
import { TelegramAccountCredentialService } from './telegram-account-credential.service';

const KEY_HEX = '11'.repeat(32);
const OTHER_KEY_HEX = '22'.repeat(32);

const originalKey = process.env.TELEGRAM_ACCOUNT_ENCRYPTION_KEY;

describe('TelegramAccountCredentialService', () => {
  afterEach(() => {
    if (originalKey === undefined) delete process.env.TELEGRAM_ACCOUNT_ENCRYPTION_KEY;
    else process.env.TELEGRAM_ACCOUNT_ENCRYPTION_KEY = originalKey;
  });

  function create(key: string | undefined): TelegramAccountCredentialService {
    if (key === undefined) delete process.env.TELEGRAM_ACCOUNT_ENCRYPTION_KEY;
    else process.env.TELEGRAM_ACCOUNT_ENCRYPTION_KEY = key;
    return new TelegramAccountCredentialService(new ConfigService());
  }

  it('加密后可解密，密文包含版本前缀且不含明文', () => {
    const service = create(KEY_HEX);
    const payload = { token: '123456:AAF-SECRET-VALUE', phoneNumber: '+8613800000000' };
    const cipher = service.encryptCredential(payload);

    expect(service.isAvailable()).toBe(true);
    expect(service.cipherVersion()).toBe('v1');
    expect(cipher).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(cipher).not.toContain('AAF-SECRET-VALUE');
    expect(cipher).not.toContain('+8613800000000');
    expect(service.decryptCredential(cipher)).toEqual(payload);
  });

  it('根密钥不可用时拒绝加密（返回 null，绝不落明文）', () => {
    const service = create(undefined);
    expect(service.isAvailable()).toBe(false);
    expect(service.encryptCredential({ token: 'secret' })).toBeNull();
  });

  it('根密钥变更后无法解密（返回 null 而不是抛异常）', () => {
    const encrypted = create(KEY_HEX).encryptCredential({ token: 'secret' });
    const rotated = create(OTHER_KEY_HEX);
    expect(rotated.decryptCredential(encrypted)).toBeNull();
  });

  it('密文被篡改或版本不符时拒绝解密', () => {
    const service = create(KEY_HEX);
    const cipher = service.encryptCredential({ token: 'secret' }) as string;
    const parts = cipher.split(':');

    expect(service.decryptCredential('v9:aaaa:bbbb:cccc')).toBeNull();
    expect(service.decryptCredential('not-a-cipher')).toBeNull();
    expect(service.decryptCredential(null)).toBeNull();
    // 篡改密文主体（认证标签校验必须失败）
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('tampered').toString('base64')].join(':');
    expect(service.decryptCredential(tampered)).toBeNull();
  });

  it('支持 hex 与 base64 两种根密钥写法，长度不符时视为不可用', () => {
    const base64Key = Buffer.from(KEY_HEX, 'hex').toString('base64');
    expect(create(base64Key).isAvailable()).toBe(true);
    expect(create('short-key').isAvailable()).toBe(false);
  });
});
