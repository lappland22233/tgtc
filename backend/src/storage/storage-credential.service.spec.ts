import { StorageCredentialService } from './storage-credential.service';

function makeService(key?: string): StorageCredentialService {
  const config = { get: jest.fn((name: string) => (name === 'STORAGE_ENCRYPTION_KEY' ? key : undefined)) };
  return new StorageCredentialService(config as never);
}

const KEY_HEX = 'a'.repeat(64);

describe('StorageCredentialService（AES-256-GCM，fail-closed）', () => {
  it('未配置根密钥时不可用，encrypt 返回 null（绝不落明文）', () => {
    const service = makeService(undefined);
    expect(service.isAvailable()).toBe(false);
    expect(service.encryptCredential({ accessKeyId: 'x', secretAccessKey: 'y' })).toBeNull();
  });

  it('非法长度根密钥视为不可用', () => {
    expect(makeService('short').isAvailable()).toBe(false);
    expect(makeService('z'.repeat(64)).isAvailable()).toBe(false); // 非 hex 且 base64 解码长度不符
  });

  it('hex 根密钥加解密往返一致', () => {
    const service = makeService(KEY_HEX);
    expect(service.isAvailable()).toBe(true);
    const payload = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-value' };
    const cipher = service.encryptCredential(payload);
    expect(cipher).toBeTruthy();
    expect(cipher).not.toContain('secret-value');
    expect(cipher!.startsWith('v1:')).toBe(true);
    expect(service.decryptCredential(cipher)).toEqual(payload);
  });

  it('base64 根密钥同样可用', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const service = makeService(key);
    expect(service.isAvailable()).toBe(true);
    const cipher = service.encryptCredential({ refreshToken: 'rt' });
    expect(service.decryptCredential(cipher)).toEqual({ refreshToken: 'rt' });
  });

  it('密文损坏/版本不符/密钥变更时 decrypt 返回 null（不抛异常）', () => {
    const service = makeService(KEY_HEX);
    const cipher = service.encryptCredential({ username: 'u', password: 'p' })!;
    expect(service.decryptCredential(null)).toBeNull();
    expect(service.decryptCredential('garbage')).toBeNull();
    expect(service.decryptCredential(`v2:${cipher.slice(3)}`)).toBeNull();
    const tampered = cipher.slice(0, -6) + 'AAAAAA';
    expect(service.decryptCredential(tampered)).toBeNull();
    const otherKey = makeService('b'.repeat(64));
    expect(otherKey.decryptCredential(cipher)).toBeNull();
  });

  it('每次加密使用随机 IV（同载荷密文不同）', () => {
    const service = makeService(KEY_HEX);
    const a = service.encryptCredential({ password: 'p' });
    const b = service.encryptCredential({ password: 'p' });
    expect(a).not.toEqual(b);
  });
});