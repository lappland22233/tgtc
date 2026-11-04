import { BadRequestException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import axios from 'axios';
import {
  GDriveOAuthService,
  GDRIVE_OAUTH_CLIENT_ID_KEY,
  GDRIVE_OAUTH_CLIENT_SECRET_KEY,
  GDRIVE_SCOPES,
} from './gdrive-oauth.service';
import { StorageCredentialService } from './storage-credential.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

const mockGenerateAuthUrl = jest.fn((_options: Record<string, unknown>) => 'https://accounts.google.com/o/oauth2/v2/auth?mock=1');
const mockGetToken = jest.fn();
const mockSetCredentials = jest.fn();
const mockGetAccessToken = jest.fn(async () => ({ token: 'access-token' }));

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    generateAuthUrl: mockGenerateAuthUrl,
    getToken: mockGetToken,
    setCredentials: mockSetCredentials,
    getAccessToken: mockGetAccessToken,
  })),
}));

const api = axios as unknown as { get: jest.Mock };
const KEY_HEX = 'c'.repeat(64);

function makeService(opts: { clientId?: string; secretCipher?: string | null; keyAvailable?: boolean } = {}) {
  const store = new Map<string, string>();
  if (opts.clientId !== undefined) store.set(GDRIVE_OAUTH_CLIENT_ID_KEY, opts.clientId);
  if (opts.secretCipher !== undefined && opts.secretCipher !== null) {
    store.set(GDRIVE_OAUTH_CLIENT_SECRET_KEY, opts.secretCipher);
  }
  const configCache = {
    get: jest.fn(async (key: string, fallback: string) => store.get(key) ?? fallback),
    set: jest.fn(async (key: string, value: string) => { store.set(key, value); }),
  };
  const credential = new StorageCredentialService({
    get: (name: string) => (name === 'STORAGE_ENCRYPTION_KEY' && opts.keyAvailable !== false ? KEY_HEX : undefined),
  } as never);
  const service = new GDriveOAuthService(configCache as never, credential);
  return { service, configCache, credential, store };
}

/** 用真实加密服务产出的 secret 密文（模拟已配置状态） */
function encryptedSecret(value: string): string {
  const { credential } = makeService();
  return credential.encryptCredential({ value })!;
}

describe('GDriveOAuthService（mock OAuth + 录制响应）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccessToken.mockResolvedValue({ token: 'access-token' });
  });

  it('未配置时 getClientConfig 返回 null；配置后 secret 解密还原', async () => {
    const { service } = makeService();
    expect(await service.getClientConfig()).toBeNull();
    expect(await service.isConfigured()).toBe(false);

    const { service: configured } = makeService({
      clientId: 'client-123.apps.googleusercontent.com',
      secretCipher: encryptedSecret('super-secret'),
    });
    expect(await configured.getClientConfig()).toEqual({
      clientId: 'client-123.apps.googleusercontent.com',
      clientSecret: 'super-secret',
    });
  });

  it('setClientConfig：secret 加密落库（明文不出现在存储值中）', async () => {
    const { service, store } = makeService();
    await service.setClientConfig('client-abc', 'plain-secret-value');
    expect(store.get(GDRIVE_OAUTH_CLIENT_ID_KEY)).toBe('client-abc');
    const stored = store.get(GDRIVE_OAUTH_CLIENT_SECRET_KEY)!;
    expect(stored.startsWith('v1:')).toBe(true);
    expect(stored).not.toContain('plain-secret-value');
  });

  it('setClientConfig：根密钥缺失时拒绝（fail-closed）', async () => {
    const { service } = makeService({ keyAvailable: false });
    await expect(service.setClientConfig('id', 'secret')).rejects.toThrow('STORAGE_ENCRYPTION_KEY');
  });

  it('buildAuthUrl：offline + consent + drive.file scope（规避受限 scope 审核）', async () => {
    const { service } = makeService({ clientId: 'cid', secretCipher: encryptedSecret('sec') });
    const url = await service.buildAuthUrl('http://localhost/callback');
    expect(url).toContain('accounts.google.com');
    expect(OAuth2Client).toHaveBeenCalledWith('cid', 'sec', 'http://localhost/callback');
    const options = mockGenerateAuthUrl.mock.calls[0][0] as Record<string, unknown>;
    expect(options.access_type).toBe('offline');
    expect(options.prompt).toBe('consent');
    expect(options.scope).toEqual(GDRIVE_SCOPES);
    expect(GDRIVE_SCOPES).toContain('https://www.googleapis.com/auth/drive.file');
  });

  it('buildAuthUrl：未配置 Client / 缺 redirectUri 直接 400', async () => {
    const { service } = makeService();
    await expect(service.buildAuthUrl('http://x')).rejects.toThrow(BadRequestException);
    const { service: configured } = makeService({ clientId: 'cid', secretCipher: encryptedSecret('sec') });
    await expect(configured.buildAuthUrl('  ')).rejects.toThrow('redirectUri');
  });

  it('exchangeCode 成功：refresh_token + 邮箱 + 配额（录制响应）', async () => {
    mockGetToken.mockResolvedValue({ tokens: { refresh_token: 'rt-1', access_token: 'at-1' } });
    api.get
      .mockResolvedValueOnce({ data: { email: 'user@gmail.com' } }) // userinfo
      .mockResolvedValueOnce({ data: { storageQuota: { limit: String(15 * 1024 ** 3), usage: '1024' } } }); // about
    const { service } = makeService({ clientId: 'cid', secretCipher: encryptedSecret('sec') });
    const result = await service.exchangeCode('auth-code', 'http://localhost/callback');
    expect(result.refreshToken).toBe('rt-1');
    expect(result.email).toBe('user@gmail.com');
    expect(result.quota).toEqual({ totalBytes: 15 * 1024 ** 3, usedBytes: 1024 });
    expect(mockGetToken).toHaveBeenCalledWith('auth-code');
    expect(mockSetCredentials).toHaveBeenCalledWith({ refresh_token: 'rt-1', access_token: 'at-1' });
  });

  it('exchangeCode：invalid_grant → 可操作 400（不回显凭据）', async () => {
    mockGetToken.mockRejectedValue(new Error('invalid_grant: Code was already redeemed.'));
    const { service } = makeService({ clientId: 'cid', secretCipher: encryptedSecret('sec') });
    await expect(service.exchangeCode('bad-code', 'http://x')).rejects.toThrow('授权码无效或已过期');
  });

  it('exchangeCode：Google 未下发 refresh_token → 提示重新授权', async () => {
    mockGetToken.mockResolvedValue({ tokens: { access_token: 'at-only' } });
    const { service } = makeService({ clientId: 'cid', secretCipher: encryptedSecret('sec') });
    await expect(service.exchangeCode('code', 'http://x')).rejects.toThrow('refresh_token');
  });

  it('exchangeCode：邮箱/配额拉取失败不影响授权主结论', async () => {
    mockGetToken.mockResolvedValue({ tokens: { refresh_token: 'rt-2' } });
    api.get.mockRejectedValue(new Error('network down'));
    const { service } = makeService({ clientId: 'cid', secretCipher: encryptedSecret('sec') });
    const result = await service.exchangeCode('code', 'http://x');
    expect(result.refreshToken).toBe('rt-2');
    expect(result.email).toBeNull();
    expect(result.quota).toBeNull();
  });

  it('fetchQuota：无 limit（Workspace 无限）→ totalBytes=null', async () => {
    api.get.mockResolvedValueOnce({ data: { storageQuota: { usage: '2048' } } });
    const { service } = makeService({ clientId: 'cid', secretCipher: encryptedSecret('sec') });
    const client = await service.createAuthorizedClient('rt');
    expect(await service.fetchQuota(client)).toEqual({ totalBytes: null, usedBytes: 2048 });
  });

  it('createAuthorizedClient：未配置 OAuth Client 时抛 auth 类错误', async () => {
    const { service } = makeService();
    await expect(service.createAuthorizedClient('rt')).rejects.toMatchObject({ kind: 'auth' });
  });
});