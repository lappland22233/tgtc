import { BadRequestException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import axios from 'axios';
import {
  GDriveOAuthService,
  GDRIVE_OAUTH_CLIENT_ID_KEY,
  GDRIVE_OAUTH_CLIENT_SECRET_KEY,
  GDRIVE_OAUTH_REDIRECT_URI_KEY,
  GDRIVE_SCOPES,
  extractOAuthCode,
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
  CodeChallengeMethod: { S256: 'S256' },
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
  const pending = new Map<string, string>();
  const configStore = {
    settings: jest.fn(async () => ({
      clientId: store.get(GDRIVE_OAUTH_CLIENT_ID_KEY) || '',
      secretCipher: store.get(GDRIVE_OAUTH_CLIENT_SECRET_KEY) || '',
      redirectUri: store.get(GDRIVE_OAUTH_REDIRECT_URI_KEY) || null,
      revision: 'test-revision',
    })),
    writeSettings: jest.fn(async (id: string, cipher?: string, uri?: string) => {
      store.set(GDRIVE_OAUTH_CLIENT_ID_KEY, id);
      if (cipher || !id) store.set(GDRIVE_OAUTH_CLIENT_SECRET_KEY, cipher || '');
      if (uri !== undefined) store.set(GDRIVE_OAUTH_REDIRECT_URI_KEY, uri);
    }),
    issue: jest.fn(async (binding: string) => { pending.set('state', binding); return 'state'; }),
    consume: jest.fn(async (key: string, binding: string) => {
      if (pending.get(key) !== binding) throw new BadRequestException('授权状态无效');
      pending.delete(key);
    }),
  };
  const credential = new StorageCredentialService({
    get: (name: string) => (name === 'STORAGE_ENCRYPTION_KEY' && opts.keyAvailable !== false ? KEY_HEX : undefined),
  } as never);
  const service = new GDriveOAuthService(configStore as never, credential);
  return { service, credential, store };
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
      redirectUri: null,
    });
  });

  it('setClientConfig：secret 加密落库，且可选持久化常用 redirectUri', async () => {
    const { service, store } = makeService();
    await service.setClientConfig('client-abc', 'plain-secret-value', 'https://example.com/callback');
    expect(store.get(GDRIVE_OAUTH_CLIENT_ID_KEY)).toBe('client-abc');
    const stored = store.get(GDRIVE_OAUTH_CLIENT_SECRET_KEY)!;
    expect(stored.startsWith('v1:')).toBe(true);
    expect(stored).not.toContain('plain-secret-value');
    expect(store.get(GDRIVE_OAUTH_REDIRECT_URI_KEY)).toBe('https://example.com/callback');

    expect(await service.getClientConfig()).toEqual({
      clientId: 'client-abc',
      clientSecret: 'plain-secret-value',
      redirectUri: 'https://example.com/callback',
    });

    await service.setClientConfig('client-abc', '', 'https://new.example.com');
    expect((await service.getClientConfig())?.clientSecret).toBe('plain-secret-value');
  });

  it('clearClientConfig：清除 OAuth Client 配置与重定向地址', async () => {
    const { service } = makeService({ clientId: 'id', secretCipher: encryptedSecret('sec') });
    expect(await service.isConfigured()).toBe(true);
    await service.clearClientConfig();
    expect(await service.isConfigured()).toBe(false);
  });

  it('extractOAuthCode：智能解析纯 code、完整重定向 URL 及 query 串', () => {
    // 纯 code
    expect(extractOAuthCode('4/0AcvXYZ123')).toBe('4/0AcvXYZ123');
    // 带空格的纯 code
    expect(extractOAuthCode('  4/0AcvXYZ123  ')).toBe('4/0AcvXYZ123');
    // 完整重定向 URL (带其他参数)
    expect(extractOAuthCode('http://localhost:5173/admin/storage-backends/gdrive-callback?state=xyz&code=4/0AcvXYZ123&scope=email'))
      .toBe('4/0AcvXYZ123');
    // 裸 query 字符串
    expect(extractOAuthCode('code=4/0AcvXYZ123&scope=email')).toBe('4/0AcvXYZ123');
    // URL 编码的 code 参数
    expect(extractOAuthCode('https://example.com/cb?code=4%2F0AcvXYZ123')).toBe('4/0AcvXYZ123');
  });

  it('setClientConfig：根密钥缺失时拒绝（fail-closed）', async () => {
    const { service } = makeService({ keyAvailable: false });
    await expect(service.setClientConfig('id', 'secret')).rejects.toThrow('STORAGE_ENCRYPTION_KEY');
  });

  it('buildAuthUrl：offline + consent + drive.file scope（规避受限 scope 审核）', async () => {
    const { service } = makeService({ clientId: 'cid', secretCipher: encryptedSecret('sec') });
    const {url} = await service.beginFlow('admin', 'session', 'http://localhost/callback');
    expect(url).toContain('accounts.google.com');
    expect(OAuth2Client).toHaveBeenCalledWith('cid', 'sec', 'http://localhost/callback');
    const options = mockGenerateAuthUrl.mock.calls[0][0] as Record<string, unknown>;
    expect(options.code_challenge_method).toBe('S256');
    expect(options.code_challenge).toEqual(expect.any(String));
    expect(options.access_type).toBe('offline');
    expect(options.prompt).toBe('consent');
    expect(options.scope).toEqual(GDRIVE_SCOPES);
    expect(GDRIVE_SCOPES).toContain('https://www.googleapis.com/auth/drive.file');
  });

  it('buildAuthUrl：未配置 Client / 缺 redirectUri 直接 400', async () => {
    const { service } = makeService();
    await expect(service.beginFlow('admin', 'session', 'http://x')).rejects.toThrow(BadRequestException);
    const { service: configured } = makeService({ clientId: 'cid', secretCipher: encryptedSecret('sec') });
    await expect(configured.beginFlow('admin', 'session', '  ')).rejects.toThrow('redirectUri');
  });

  it('exchangeCode 成功：refresh_token + 邮箱 + 配额（录制响应，支持全 URL 自动解析 code）', async () => {
    mockGetToken.mockResolvedValue({ tokens: { refresh_token: 'rt-1', access_token: 'at-1' } });
    api.get
      .mockResolvedValueOnce({ data: { email: 'user@gmail.com' } }) // userinfo
      .mockResolvedValueOnce({ data: { storageQuota: { limit: String(15 * 1024 ** 3), usage: '1024' } } }); // about
    const { service } = makeService({ clientId: 'cid', secretCipher: encryptedSecret('sec') });
    const result = await complete(service, 'https://example.com/callback?code=auth-code&state=123', 'http://localhost/callback');
    expect(result.refreshToken).toBe('rt-1');
    expect(result.email).toBe('user@gmail.com');
    expect(result.quota).toEqual({ totalBytes: 15 * 1024 ** 3, usedBytes: 1024 });
    expect(mockGetToken).toHaveBeenCalledWith({ code: 'auth-code', codeVerifier: expect.any(String) });
    expect(mockSetCredentials).toHaveBeenCalledWith({ refresh_token: 'rt-1', access_token: 'at-1' });
  });

  it('exchangeCode：invalid_grant → 可操作 400（不回显凭据）', async () => {
    mockGetToken.mockRejectedValue(new Error('invalid_grant: Code was already redeemed.'));
    const { service } = makeService({ clientId: 'cid', secretCipher: encryptedSecret('sec') });
    await expect(complete(service, 'bad-code', 'http://x')).rejects.toThrow('授权码无效或已过期');
  });

  it('exchangeCode：Google 未下发 refresh_token → 提示重新授权', async () => {
    mockGetToken.mockResolvedValue({ tokens: { access_token: 'at-only' } });
    const { service } = makeService({ clientId: 'cid', secretCipher: encryptedSecret('sec') });
    await expect(complete(service, 'code', 'http://x')).rejects.toThrow('refresh_token');
  });

  it('exchangeCode：邮箱/配额拉取失败不影响授权主结论', async () => {
    mockGetToken.mockResolvedValue({ tokens: { refresh_token: 'rt-2' } });
    api.get.mockRejectedValue(new Error('network down'));
    const { service } = makeService({ clientId: 'cid', secretCipher: encryptedSecret('sec') });
    const result = await complete(service, 'code', 'http://x');
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

  it('pins authorization to this administrator, session, redirect URI and target and consumes it once', async () => {
    const { service } = makeService({clientId: 'cid', secretCipher: encryptedSecret('sec')});
    const {state} = await service.beginFlow('admin', 's1', 'http://localhost/callback', 'existing');
    const input = {code: 'code', state, redirectUri: 'http://localhost/callback', accountId: 'existing'};
    for (const [user, session, change] of [
      ['other', 's1', {}], ['admin', 's2', {}],
      ['admin', 's1', {accountId: 'other'}], ['admin', 's1', {redirectUri: 'https://example.com'}],
    ] as const) {
      await expect(service.completeFlow(user, session, {...input, ...change})).rejects.toThrow('授权状态');
    }
    expect(mockGetToken).not.toHaveBeenCalled();
    mockGetToken.mockResolvedValue({tokens: {refresh_token: 'rt'}});
    await service.completeFlow('admin', 's1', input);
    await expect(service.completeFlow('admin', 's1', input)).rejects.toThrow('授权状态');
  });
});

async function complete(service: GDriveOAuthService, code: string, redirectUri: string) {
  const {state} = await service.beginFlow('admin', 'session', redirectUri);
  return service.completeFlow('admin', 'session', {state, code, redirectUri});
}
