import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { CodeChallengeMethod, type Credentials, OAuth2Client } from 'google-auth-library';
import axios from 'axios';
import https from 'https';
import { createHash, createHmac } from 'crypto';
import { GDriveOAuthStore } from './gdrive-oauth-store.service';
import { StorageCredentialService } from './storage-credential.service';
import { StorageAccountError, StorageQuota } from './storage.types';
import { toStorageAccountError } from './storage-errors.util';

export { GDRIVE_OAUTH_CLIENT_ID_KEY, GDRIVE_OAUTH_CLIENT_SECRET_KEY, GDRIVE_OAUTH_REDIRECT_URI_KEY } from './gdrive-oauth-store.service';

/**
 * 智能提取授权码：若传入的是完整回调 URL 或带有 code 的 query 字符串，
 * 自动解析提取其中的 code 参数值；否则去除首尾空格返回原串。
 */
export function extractOAuthCode(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes('code=')) {
    try {
      const url = trimmed.startsWith('http://') || trimmed.startsWith('https://')
        ? new URL(trimmed)
        : new URL(`http://localhost/?${trimmed}`);
      const code = url.searchParams.get('code');
      if (code) return code.trim();
    } catch {
      const match = trimmed.match(/[?&]code=([^&#]+)/);
      if (match && match[1]) return decodeURIComponent(match[1]).trim();
    }
  }
  return trimmed;
}

/**
 * 授权 scope：drive.file 仅访问本应用创建的文件（规避 Google 受限 scope 审核），
 * openid+email 为非敏感身份 scope（仅用于管理端展示授权账号邮箱）。
 */
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GDRIVE_SCOPES = [
  DRIVE_FILE_SCOPE,
  'openid',
  'email',
];

export interface GDriveOAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string | null;
}

export interface GDriveAuthExchangeResult {
  refreshToken: string;
  email: string | null;
  quota: StorageQuota | null;
}

/**
 * Google Drive OAuth 接入（个人账号，两段式授权，参照 telegram-user-auth 模式）：
 * 1. 管理员在后台配置 OAuth Client（client_id + client_secret，secret 加密落库）；
 * 2. `buildAuthUrl` 生成授权 URL（access_type=offline + prompt=consent 保证拿到
 *    refresh_token）；管理员浏览器完成授权后从回调 URL 复制 code；
 * 3. `exchangeCode` 换取 refresh_token 并拉取邮箱/配额，由账号服务加密落库。
 *
 * 安全：client_secret 与 refresh_token 一律经 StorageCredentialService 加密，
 * 接口/日志/审计永不回显明文。
 */
@Injectable()
export class GDriveOAuthService {
  private readonly logger = new Logger(GDriveOAuthService.name);
  private readonly httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 60_000,
    maxSockets: 32,
    maxFreeSockets: 8,
    timeout: 30_000,
  });

  constructor(
    private readonly store: GDriveOAuthStore,
    private readonly credential: StorageCredentialService,
  ) {}

  /** 读取 OAuth Client 配置（secret 解密）；未配置或不可解密返回 null */
  async getClientConfig(): Promise<GDriveOAuthClientConfig | null> {
    const { clientId, secretCipher, redirectUri } = await this.store.settings();
    if (!clientId || !secretCipher) return null;
    const payload = this.credential.decryptCredential<{ value: string }>(secretCipher);
    if (!payload?.value) return null;
    return { clientId, clientSecret: payload.value, redirectUri };
  }

  /** 管理端配置 OAuth Client（secret 加密后写入 SystemConfig，留空 clientSecret 保留现有密钥） */
  async setClientConfig(clientId: string, clientSecret?: string, redirectUri?: string): Promise<void> {
    const trimmedId = clientId.trim();
    const trimmedSecret = clientSecret ? clientSecret.trim() : '';
    if (!trimmedId) throw new BadRequestException('client_id 必填');

    let cipher: string | undefined;
    if (trimmedSecret) {
      if (!this.credential.isAvailable()) {
        throw new BadRequestException('未配置 STORAGE_ENCRYPTION_KEY，无法加密保存 OAuth client_secret');
      }
      const encrypted = this.credential.encryptCredential({ value: trimmedSecret });
      if (!encrypted) throw new BadRequestException('client_secret 加密失败');
      cipher = encrypted;
    }
    await this.store.writeSettings(trimmedId, cipher, redirectUri?.trim());
  }

  async clearClientConfig(): Promise<void> {
    await this.store.writeSettings('', undefined, '');
  }

  /** 是否已配置可用 OAuth Client（管理端授权向导前置检查） */
  async isConfigured(): Promise<boolean> {
    return (await this.getClientConfig()) !== null;
  }

  private async flowContext(adminId: string, session: string, redirectUri: string, accountId?: string) {
    if (!adminId || !session || !redirectUri?.trim()) throw new BadRequestException('缺少当前会话或 redirectUri');
    const settings = await this.store.settings();
    if (!settings.clientId || !settings.secretCipher) throw new BadRequestException('请先配置 Google Drive OAuth Client');
    const secret = this.credential.decryptCredential<{ value: string }>(settings.secretCipher)?.value;
    if (!secret) throw new BadRequestException('OAuth Client 凭据无效');
    const binding = JSON.stringify([adminId, session, redirectUri.trim(), accountId || null, settings.revision]);
    return { clientId: settings.clientId, secret, binding, revision: settings.revision };
  }

  async beginFlow(adminId: string, session: string, redirectUri: string, accountId?: string) {
    const ctx = await this.flowContext(adminId, session, redirectUri, accountId);
    const state = await this.store.issue(ctx.binding);
    const verifier = this.codeVerifier(ctx.secret, state);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = this.buildAuthUrl({ clientId: ctx.clientId, clientSecret: ctx.secret }, redirectUri, state, challenge);
    return { url, state };
  }

  async completeFlow(adminId: string, session: string, input: { code: string; state: string; redirectUri: string; accountId?: string }) {
    if (!input.state) throw new BadRequestException('授权已过期，请重新发起');
    const ctx = await this.flowContext(adminId, session, input.redirectUri, input.accountId);
    await this.store.consume(input.state, ctx.binding);
    const result = await this.exchangeCode(
      { clientId: ctx.clientId, clientSecret: ctx.secret }, input.code, input.redirectUri, this.codeVerifier(ctx.secret, input.state),
    );
    return { ...result, revision: ctx.revision };
  }

  // The random state is unique to this attempt. Derive its secret PKCE verifier
  // so the database never needs to store a reusable verifier in plaintext.
  private codeVerifier(secret: string, state: string): string {
    return createHmac('sha256', secret).update('tgtc:gdrive:pkce:' + state).digest('base64url');
  }

  private buildAuthUrl(config: GDriveOAuthClientConfig, redirectUri: string, state: string, challenge: string): string {
    const trimmed = redirectUri.trim();
    if (!trimmed) throw new BadRequestException('redirectUri 必填（须与 Google Console 登记一致）');
    const client = new OAuth2Client(config.clientId, config.clientSecret, trimmed);
    return client.generateAuthUrl({
      access_type: 'offline',
      // 强制 consent：重复授权也能拿到 refresh_token（否则 Google 只在首次授权下发）
      prompt: 'consent',
      scope: GDRIVE_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
  }

  /** code 换取 refresh_token + 邮箱 + 配额（失败抛可诊断错误，绝不回显凭据） */
  private async exchangeCode(config: GDriveOAuthClientConfig, code: string, redirectUri: string, codeVerifier: string): Promise<GDriveAuthExchangeResult> {
    const cleanCode = extractOAuthCode(code);
    if (!cleanCode) throw new BadRequestException('授权码不能为空');
    const client = new OAuth2Client(config.clientId, config.clientSecret, redirectUri.trim());
    let tokens;
    try {
      ({ tokens } = await client.getToken({ code: cleanCode, codeVerifier }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // invalid_grant：code 过期/已用/redirectUri 不匹配——可操作提示，不含凭据
      if (/invalid_grant/i.test(message)) {
        throw new BadRequestException('授权码无效或已过期（请重新授权，并确认 redirectUri 与授权时一致）');
      }
      throw new BadRequestException('Google 授权码交换失败，请重新发起授权；如持续失败，请检查 OAuth Client 配置');
    }
    await this.requireDriveFileScope(client, tokens);
    if (!tokens.refresh_token) {
      throw new BadRequestException('Google 未下发 refresh_token，请重新发起授权并完成 Google 同意流程');
    }
    client.setCredentials(tokens);

    let email: string | null = null;
    try {
      const token = await client.getAccessToken();
      const profile = await axios.get<{ email?: string }>(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        { headers: { Authorization: `Bearer ${token.token}` }, timeout: 15_000, httpsAgent: this.httpsAgent },
      );
      email = profile.data?.email ?? null;
    } catch (error) {
      this.logger.warn(`GDrive 授权账号邮箱拉取失败（不影响授权）：${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
    }

    let quota: StorageQuota | null = null;
    try {
      quota = await this.fetchQuota(client);
    } catch (error) {
      this.logger.warn(`GDrive 授权配额拉取失败（不影响授权）：${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
    }
    return { refreshToken: tokens.refresh_token, email, quota };
  }

  private async requireDriveFileScope(client: OAuth2Client, tokens: Credentials): Promise<void> {
    let scopes = tokens.scope?.split(/\s+/);
    if (!scopes) {
      // Google may omit scope in a token response. Verify the exchanged access
      // token itself before using the candidate credentials for any Drive call.
      if (!tokens.access_token) {
        throw new BadRequestException('Google 未返回可供验证的访问令牌，请重新发起授权');
      }
      try {
        scopes = (await client.getTokenInfo(tokens.access_token)).scopes;
      } catch {
        // SDK errors can contain the bearer token in their request details.
        throw new ServiceUnavailableException({
          errorCode: 'GDRIVE_SCOPE_VERIFICATION_UNAVAILABLE',
          message: '暂时无法向 Google 确认授权范围，请稍后重新发起授权',
        });
      }
    }
    if (!scopes.includes(DRIVE_FILE_SCOPE)) {
      throw new BadRequestException('未授予 Google Drive 文件访问权限（drive.file）。请重新发起授权，并在 Google 同意页面勾选允许本应用访问其使用的云端硬盘文件。');
    }
  }

  /** 构造已装载 refresh_token 的 OAuth2Client（自动刷新 access_token） */
  async createAuthorizedClient(refreshToken: string, snapshot?: GDriveOAuthClientConfig): Promise<OAuth2Client> {
    const config = snapshot ?? await this.getClientConfig();
    if (!config) {
      throw new StorageAccountError('GDrive OAuth Client 未配置', 'auth');
    }
    const client = new OAuth2Client(config.clientId, config.clientSecret);
    client.setCredentials({ refresh_token: refreshToken });
    return client;
  }

  /** about.get storageQuota：个人账号 limit=15GB；无 limit（Workspace 无限）→ null */
  async fetchQuota(client: OAuth2Client): Promise<StorageQuota> {
    try {
      const token = await client.getAccessToken();
      const response = await axios.get<{ storageQuota?: { limit?: string; usage?: string } }>(
        'https://www.googleapis.com/drive/v3/about',
        {
          params: { fields: 'storageQuota' },
          headers: { Authorization: `Bearer ${token.token}` },
          timeout: 15_000,
          httpsAgent: this.httpsAgent,
        },
      );
      const quota = response.data?.storageQuota ?? {};
      const limit = quota.limit === undefined ? null : Number(quota.limit);
      return {
        totalBytes: limit !== null && Number.isFinite(limit) ? limit : null,
        usedBytes: Number(quota.usage ?? 0) || 0,
      };
    } catch (error) {
      throw toStorageAccountError(error, 'GDrive 配额查询失败');
    }
  }
}