import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import axios from 'axios';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { StorageCredentialService } from './storage-credential.service';
import { StorageAccountError, StorageQuota } from './storage.types';
import { toStorageAccountError } from './storage-errors.util';

/** OAuth Client 配置键（SystemConfig；secret 以密文存放） */
export const GDRIVE_OAUTH_CLIENT_ID_KEY = 'GDRIVE_OAUTH_CLIENT_ID';
export const GDRIVE_OAUTH_CLIENT_SECRET_KEY = 'GDRIVE_OAUTH_CLIENT_SECRET';

/**
 * 授权 scope：drive.file 仅访问本应用创建的文件（规避 Google 受限 scope 审核），
 * openid+email 为非敏感身份 scope（仅用于管理端展示授权账号邮箱）。
 */
export const GDRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email',
];

export interface GDriveOAuthClientConfig {
  clientId: string;
  clientSecret: string;
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

  constructor(
    private readonly configCache: ConfigCacheService,
    private readonly credential: StorageCredentialService,
  ) {}

  /** 读取 OAuth Client 配置（secret 解密）；未配置或不可解密返回 null */
  async getClientConfig(): Promise<GDriveOAuthClientConfig | null> {
    const clientId = (await this.configCache.get(GDRIVE_OAUTH_CLIENT_ID_KEY, '')).trim();
    const secretCipher = (await this.configCache.get(GDRIVE_OAUTH_CLIENT_SECRET_KEY, '')).trim();
    if (!clientId || !secretCipher) return null;
    const payload = this.credential.decryptCredential<{ value: string }>(secretCipher);
    if (!payload?.value) return null;
    return { clientId, clientSecret: payload.value };
  }

  /** 管理端配置 OAuth Client（secret 加密后写入 SystemConfig） */
  async setClientConfig(clientId: string, clientSecret: string): Promise<void> {
    const trimmedId = clientId.trim();
    const trimmedSecret = clientSecret.trim();
    if (!trimmedId || !trimmedSecret) throw new BadRequestException('client_id 与 client_secret 均必填');
    if (!this.credential.isAvailable()) {
      throw new BadRequestException('未配置 STORAGE_ENCRYPTION_KEY，无法加密保存 OAuth client_secret');
    }
    const cipher = this.credential.encryptCredential({ value: trimmedSecret });
    if (!cipher) throw new BadRequestException('client_secret 加密失败');
    await this.configCache.set(GDRIVE_OAUTH_CLIENT_ID_KEY, trimmedId, 'Google Drive OAuth Client ID');
    await this.configCache.set(GDRIVE_OAUTH_CLIENT_SECRET_KEY, cipher, 'Google Drive OAuth Client Secret（AES-256-GCM 密文）');
  }

  /** 是否已配置可用 OAuth Client（管理端授权向导前置检查） */
  async isConfigured(): Promise<boolean> {
    return (await this.getClientConfig()) !== null;
  }

  /** 生成授权 URL（redirectUri 必须已在 Google Console 登记） */
  async buildAuthUrl(redirectUri: string): Promise<string> {
    const config = await this.getClientConfig();
    if (!config) throw new BadRequestException('请先配置 Google Drive OAuth Client（client_id / client_secret）');
    const trimmed = redirectUri.trim();
    if (!trimmed) throw new BadRequestException('redirectUri 必填（须与 Google Console 登记一致）');
    const client = new OAuth2Client(config.clientId, config.clientSecret, trimmed);
    return client.generateAuthUrl({
      access_type: 'offline',
      // 强制 consent：重复授权也能拿到 refresh_token（否则 Google 只在首次授权下发）
      prompt: 'consent',
      scope: GDRIVE_SCOPES,
    });
  }

  /** code 换取 refresh_token + 邮箱 + 配额（失败抛可诊断错误，绝不回显凭据） */
  async exchangeCode(code: string, redirectUri: string): Promise<GDriveAuthExchangeResult> {
    const config = await this.getClientConfig();
    if (!config) throw new BadRequestException('请先配置 Google Drive OAuth Client');
    const client = new OAuth2Client(config.clientId, config.clientSecret, redirectUri.trim());
    let tokens;
    try {
      ({ tokens } = await client.getToken(code.trim()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // invalid_grant：code 过期/已用/redirectUri 不匹配——可操作提示，不含凭据
      if (/invalid_grant/i.test(message)) {
        throw new BadRequestException('授权码无效或已过期（请重新授权，并确认 redirectUri 与授权时一致）');
      }
      throw new BadRequestException(`Google 授权码交换失败：${message.slice(0, 200)}`);
    }
    if (!tokens.refresh_token) {
      throw new BadRequestException('Google 未下发 refresh_token（请撤销本应用授权后重新授权）');
    }
    client.setCredentials(tokens);

    let email: string | null = null;
    try {
      const token = await client.getAccessToken();
      const profile = await axios.get<{ email?: string }>(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        { headers: { Authorization: `Bearer ${token.token}` }, timeout: 15_000 },
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

  /** 构造已装载 refresh_token 的 OAuth2Client（自动刷新 access_token） */
  async createAuthorizedClient(refreshToken: string): Promise<OAuth2Client> {
    const config = await this.getClientConfig();
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