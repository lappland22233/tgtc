import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import type { GDriveBackendConfig, RemoteStorageBackendType } from '../common/entities/storage-backend.entity';
import { AuditService } from '../common/services/audit.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { GDriveOAuthService } from './gdrive-oauth.service';
import { StorageBackendsService } from './storage-backends.service';
import {
  STORAGE_DEFAULT_BACKEND_KEY,
  STORAGE_GDRIVE_CACHE_MODE_KEY,
  STORAGE_GDRIVE_CHUNK_SIZE_MB_KEY,
  StorageRouterService,
} from './storage-router.service';
import {
  CreateStorageBackendDto,
  GDriveAuthUrlDto,
  GDriveCompleteAuthDto,
  GDriveOAuthClientDto,
  GDriveRotateAuthDto,
  RotateStorageCredentialDto,
  SetDefaultStorageBackendDto,
  UpdateStorageBackendDto,
  UpdateStorageSettingsDto,
} from './storage-backends.dto';

/**
 * 存储后端管理端点（仅 SUPER_ADMIN，JWT Cookie；**不接受 API Key**）。
 *
 * 隐私与安全约定（与 telegram-accounts 同口径）：
 * - 所有响应都是脱敏视图，不含密钥 / 密码 / refresh_token / client_secret；
 * - 所有写操作进入审计，metadata 只记录内部 ID、类型与结果摘要；
 * - 默认后端写 SystemConfig 热更新，上传会话创建时冻结，不影响在途任务。
 */
@Controller('admin/storage-backends')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class StorageBackendsController {
  constructor(
    private readonly backends: StorageBackendsService,
    private readonly router: StorageRouterService,
    private readonly gdriveOAuth: GDriveOAuthService,
    private readonly configCache: ConfigCacheService,
    private readonly audit: AuditService,
  ) {}

  /** 总览：账号列表 + 调度快照 + 默认后端 + 凭据加密可用性 + Google 缓存设置 */
  @Get('overview')
  @Roles(UserRole.SUPER_ADMIN)
  async overview() {
    const base = await this.backends.overview();
    const gdriveCacheModeRaw = (await this.configCache.get(STORAGE_GDRIVE_CACHE_MODE_KEY, 'false')).trim().toLowerCase();
    const gdriveChunkSizeMb = Number(await this.configCache.get(STORAGE_GDRIVE_CHUNK_SIZE_MB_KEY, '16')) || 16;
    return {
      ...base,
      defaultBackend: await this.router.getDefaultBackendType(),
      availableBackends: this.router.availableBackendTypes(),
      gdriveOAuthConfigured: await this.gdriveOAuth.isConfigured(),
      gdriveCacheMode: gdriveCacheModeRaw === 'true' || gdriveCacheModeRaw === '1',
      gdriveChunkSizeMb,
    };
  }

  /** 存储全局设置更新（默认后端、Google 缓存模式、分块上传大小） */
  @Put('settings')
  @Roles(UserRole.SUPER_ADMIN)
  async updateSettings(@CurrentUser() user: User, @Body() dto: UpdateStorageSettingsDto) {
    if (dto.backend) {
      await this.configCache.set(STORAGE_DEFAULT_BACKEND_KEY, dto.backend, '默认存储后端（新上传会话生效）');
    }
    if (dto.gdriveCacheMode !== undefined) {
      await this.configCache.set(
        STORAGE_GDRIVE_CACHE_MODE_KEY,
        dto.gdriveCacheMode ? 'true' : 'false',
        'Google 云端硬盘缓存模式（TG 主存储时镜像至 GDrive 直链免盘下载）',
      );
    }
    if (dto.gdriveChunkSizeMb !== undefined) {
      await this.configCache.set(
        STORAGE_GDRIVE_CHUNK_SIZE_MB_KEY,
        String(dto.gdriveChunkSizeMb),
        'Google Drive 分块上传大小（MB）',
      );
    }
    this.audit.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'storage_backend',
      resourceId: 'storage_settings',
      metadata: { ...dto },
    });
    const gdriveCacheModeRaw = (await this.configCache.get(STORAGE_GDRIVE_CACHE_MODE_KEY, 'false')).trim().toLowerCase();
    return {
      success: true,
      message: '存储全局设置已更新',
      defaultBackend: await this.router.getDefaultBackendType(),
      gdriveCacheMode: gdriveCacheModeRaw === 'true' || gdriveCacheModeRaw === '1',
      gdriveChunkSizeMb: Number(await this.configCache.get(STORAGE_GDRIVE_CHUNK_SIZE_MB_KEY, '16')) || 16,
    };
  }

  /** 账号列表（可按类型筛选） */
  @Get()
  @Roles(UserRole.SUPER_ADMIN)
  async list(@Query('type') type?: string) {
    const filtered = type === 's3' || type === 'webdav' || type === 'gdrive'
      ? type as RemoteStorageBackendType
      : undefined;
    return this.backends.list(filtered);
  }

  /** 默认存储后端热更新（仅影响新上传会话；在途任务按冻结值继续） */
  @Put('default-backend')
  @Roles(UserRole.SUPER_ADMIN)
  async setDefaultBackend(@CurrentUser() user: User, @Body() dto: SetDefaultStorageBackendDto) {
    const previous = await this.router.getDefaultBackendType();
    await this.configCache.set(STORAGE_DEFAULT_BACKEND_KEY, dto.backend, '默认存储后端（新上传会话生效）');
    this.audit.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'storage_backend',
      resourceId: STORAGE_DEFAULT_BACKEND_KEY,
      metadata: { previous, configured: dto.backend },
    });
    const effective = await this.router.getDefaultBackendType();
    return {
      message: effective === dto.backend
        ? `默认存储后端已切换为 ${dto.backend}（仅影响新上传）`
        : `已配置 ${dto.backend}，但当前无可用账号，实际仍回退 ${effective}`,
      defaultBackend: effective,
    };
  }

  // ---------- GDrive OAuth（声明在 :id 路由之前，避免被吞掉） ----------

  /** OAuth Client 配置状态（绝不回显 secret，包含常用 redirectUri） */
  @Get('gdrive/oauth-client')
  @Roles(UserRole.SUPER_ADMIN)
  async getGDriveOAuthClient() {
    const config = await this.gdriveOAuth.getClientConfig();
    return {
      configured: config !== null,
      clientId: config?.clientId ?? null,
      redirectUri: config?.redirectUri ?? null,
    };
  }

  /** 配置 OAuth Client（secret 加密落库） */
  @Put('gdrive/oauth-client')
  @Roles(UserRole.SUPER_ADMIN)
  async setGDriveOAuthClient(@CurrentUser() user: User, @Body() dto: GDriveOAuthClientDto) {
    await this.gdriveOAuth.setClientConfig(dto.clientId, dto.clientSecret, dto.redirectUri);
    this.audit.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'storage_backend',
      resourceId: 'gdrive_oauth_client',
      metadata: { clientIdSuffix: dto.clientId.slice(-6), hasRedirectUri: Boolean(dto.redirectUri) },
    });
    return { message: 'Google Drive OAuth Client 已保存（secret 加密存储）' };
  }

  /** 清空 OAuth Client 配置 */
  @Delete('gdrive/oauth-client')
  @Roles(UserRole.SUPER_ADMIN)
  async clearGDriveOAuthClient(@CurrentUser() user: User) {
    const existing = await this.backends.list('gdrive');
    const dependentAccounts = existing.filter((acc) => acc.status !== 'revoked' && acc.hasCredential);
    if (dependentAccounts.length > 0) {
      throw new BadRequestException(
        `当前仍有 ${dependentAccounts.length} 个未撤销的 Google Drive 存储账号依赖此 OAuth Client 配置，无法清空。请先删除或撤销相关账号。`,
      );
    }
    await this.gdriveOAuth.clearClientConfig();
    this.audit.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'storage_backend',
      resourceId: 'gdrive_oauth_client',
      metadata: { operation: 'clear' },
    });
    return { message: 'Google Drive OAuth Client 配置已清除' };
  }

  /** 生成授权 URL（管理员浏览器打开，授权后从回调 URL 复制 code） */
  @Post('gdrive/auth-url')
  @Roles(UserRole.SUPER_ADMIN)
  async gdriveAuthUrl(@CurrentUser() user: User, @Body() dto: GDriveAuthUrlDto) {
    const state = dto.state || this.gdriveOAuth.generateState(user.id);
    const url = await this.gdriveOAuth.buildAuthUrl(dto.redirectUri, state);
    return { url, state };
  }

  /** 提交授权码：创建账号，或在重新授权时更新选中的 GDrive 账号凭据。 */
  @Post('gdrive/complete-auth')
  @Roles(UserRole.SUPER_ADMIN)
  async gdriveCompleteAuth(@CurrentUser() user: User, @Body() dto: GDriveCompleteAuthDto) {
    if (dto.state && !this.gdriveOAuth.verifyState(dto.state, user.id)) {
      throw new BadRequestException('OAuth 状态校验失败或已过期 (CSRF Protection)');
    }
    const exchanged = await this.gdriveOAuth.exchangeCode(dto.code, dto.redirectUri);
    if (dto.accountId) {
      const existing = await this.backends.findById(dto.accountId);
      if (!existing) throw new NotFoundException('存储账号不存在');
      if (existing.type !== 'gdrive') throw new BadRequestException('只能为 Google Drive 账号重新授权');
      const currentEmail = (existing.config as GDriveBackendConfig | null)?.email?.trim().toLowerCase() ?? '';
      const authorizedEmail = exchanged.email?.trim().toLowerCase() ?? '';
      if (currentEmail && currentEmail !== authorizedEmail) {
        throw new BadRequestException('授权邮箱与当前账号不一致，请使用原 Google 账号重新授权');
      }
      const account = await this.backends.rotateCredential(dto.accountId, {
        refreshToken: exchanged.refreshToken,
      }, user.id);
      await this.backends.refreshQuota(dto.accountId).catch(() => {});
      this.audit.log({
        action: 'config_change',
        userId: user.id,
        resourceType: 'storage_backend',
        resourceId: dto.accountId,
        metadata: { type: 'gdrive', operation: 'oauth_rotate' },
      });
      return { message: 'Google Drive 账号已重新授权，原有文件引用保持不变', account };
    }

    const rawName = (dto.name ?? '').trim();
    const finalName = rawName || (exchanged.email ? `GDrive (${exchanged.email})` : `GDrive-${Date.now().toString(36)}`);

    const account = await this.backends.create({
      type: 'gdrive',
      name: finalName,
      config: exchanged.email ? { email: exchanged.email } : {},
      credential: { refreshToken: exchanged.refreshToken },
    }, user.id);
    this.audit.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'storage_backend',
      resourceId: account.id,
      metadata: { type: 'gdrive', operation: 'oauth_complete' },
    });
    return { message: 'Google Drive 账号授权成功并已加入存储池', account };
  }

  /** 添加存储账号（S3/WebDAV；创建即连通性测试，失败不落库） */
  @Post()
  @Roles(UserRole.SUPER_ADMIN)
  async create(@CurrentUser() user: User, @Body() dto: CreateStorageBackendDto) {
    const account = await this.backends.create({
      type: dto.type,
      name: dto.name,
      config: dto.config,
      credential: dto.credential,
      weight: dto.weight,
      maxInflight: dto.maxInflight,
      enabled: dto.enabled,
      note: dto.note,
    }, user.id);
    this.audit.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'storage_backend',
      resourceId: account.id,
      metadata: { type: dto.type, operation: 'create', name: dto.name },
    });
    return { message: '存储账号已添加并通过连通性测试', account };
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN)
  async detail(@Param('id') id: string) {
    return this.backends.detail(id);
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN)
  async update(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: UpdateStorageBackendDto) {
    const account = await this.backends.update(id, dto, user.id);
    this.audit.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'storage_backend',
      resourceId: id,
      metadata: { operation: 'update', enabled: account.enabled, weight: account.weight },
    });
    return { message: '存储账号已更新', account };
  }

  /** 撤销账号（清凭据停任务；存量文件引用保留，回源返回可诊断失败） */
  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN)
  async remove(@CurrentUser() user: User, @Param('id') id: string) {
    const account = await this.backends.revoke(id, user.id);
    this.audit.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'storage_backend',
      resourceId: id,
      metadata: { operation: 'revoke' },
    });
    return {
      message: '账号已撤销（凭据已清空；该账号上的存量文件将不可下载，远端对象不会被删除）',
      account,
    };
  }

  /** 连通性测试（结论写入健康字段；GDrive 顺带刷新配额） */
  @Post(':id/test')
  @Roles(UserRole.SUPER_ADMIN)
  async test(@CurrentUser() user: User, @Param('id') id: string) {
    const result = await this.backends.test(id);
    this.audit.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'storage_backend',
      resourceId: id,
      metadata: { operation: 'test', ok: result.probe.ok },
    });
    return { message: result.probe.ok ? '连通性测试通过' : '连通性测试失败', ...result };
  }

  /** 轮换凭据（先测试后落库；撤销账号凭此重新启用） */
  @Post(':id/rotate')
  @Roles(UserRole.SUPER_ADMIN)
  async rotate(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: RotateStorageCredentialDto) {
    const existing = await this.backends.findById(id);
    if (!existing) throw new NotFoundException('存储账号不存在');
    if (existing.type === 'gdrive') {
      throw new BadRequestException('GDrive 凭据请通过 OAuth 重新授权流程轮换，以校验账号身份');
    }
    const account = await this.backends.rotateCredential(id, dto.credential, user.id);
    this.audit.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'storage_backend',
      resourceId: id,
      metadata: { operation: 'rotate' },
    });
    return { message: '凭据已轮换并通过连通性测试', account };
  }

  /** GDrive 账号重新授权/轮换凭据（code 换取新 refreshToken 原地更新，保全历史文件） */
  @Post(':id/gdrive/rotate-auth')
  @Roles(UserRole.SUPER_ADMIN)
  async gdriveRotateAuth(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: GDriveRotateAuthDto,
  ) {
    const existing = await this.backends.findById(id);
    if (!existing) throw new NotFoundException('存储账号不存在');
    if (existing.type !== 'gdrive') throw new BadRequestException('只能为 Google Drive 账号重新授权');

    const exchanged = await this.gdriveOAuth.exchangeCode(dto.code, dto.redirectUri);
    const currentEmail = (existing.config as GDriveBackendConfig | null)?.email?.trim().toLowerCase() ?? '';
    const authorizedEmail = exchanged.email?.trim().toLowerCase() ?? '';
    if (currentEmail && currentEmail !== authorizedEmail) {
      throw new BadRequestException('授权邮箱与当前账号不一致，请使用原 Google 账号重新授权');
    }

    const account = await this.backends.rotateCredential(id, { refreshToken: exchanged.refreshToken }, user.id);
    if (exchanged.email && !currentEmail) {
      await this.backends.patchConfig(id, { email: exchanged.email });
    }
    await this.backends.refreshQuota(id).catch(() => {});
    this.audit.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'storage_backend',
      resourceId: id,
      metadata: { type: 'gdrive', operation: 'rotate_auth' },
    });
    return { message: 'Google Drive 账号已重新授权并通过连通性测试', account };
  }

  /** 手动刷新配额（GDrive 等有配额概念的后端） */
  @Post(':id/refresh-quota')
  @Roles(UserRole.SUPER_ADMIN)
  async refreshQuota(@Param('id') id: string) {
    const quota = await this.backends.refreshQuota(id);
    return { message: quota ? '配额已刷新' : '该后端无配额概念或账号不可用', quota };
  }
}
