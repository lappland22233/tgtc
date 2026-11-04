import {
  Body,
  Controller,
  Delete,
  Get,
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
import type { RemoteStorageBackendType } from '../common/entities/storage-backend.entity';
import { AuditService } from '../common/services/audit.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { GDriveOAuthService } from './gdrive-oauth.service';
import { StorageBackendsService } from './storage-backends.service';
import { STORAGE_DEFAULT_BACKEND_KEY, StorageRouterService } from './storage-router.service';
import {
  CreateStorageBackendDto,
  GDriveAuthUrlDto,
  GDriveCompleteAuthDto,
  GDriveOAuthClientDto,
  RotateStorageCredentialDto,
  SetDefaultStorageBackendDto,
  UpdateStorageBackendDto,
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
export class StorageBackendsController {
  constructor(
    private readonly backends: StorageBackendsService,
    private readonly router: StorageRouterService,
    private readonly gdriveOAuth: GDriveOAuthService,
    private readonly configCache: ConfigCacheService,
    private readonly audit: AuditService,
  ) {}

  /** 总览：账号列表 + 调度快照 + 默认后端 + 凭据加密可用性 */
  @Get('overview')
  @Roles(UserRole.SUPER_ADMIN)
  async overview() {
    const base = await this.backends.overview();
    return {
      ...base,
      defaultBackend: await this.router.getDefaultBackendType(),
      availableBackends: this.router.availableBackendTypes(),
      gdriveOAuthConfigured: await this.gdriveOAuth.isConfigured(),
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

  /** OAuth Client 配置状态（绝不回显 secret） */
  @Get('gdrive/oauth-client')
  @Roles(UserRole.SUPER_ADMIN)
  async getGDriveOAuthClient() {
    const config = await this.gdriveOAuth.getClientConfig();
    return { configured: config !== null, clientId: config?.clientId ?? null };
  }

  /** 配置 OAuth Client（secret 加密落库） */
  @Put('gdrive/oauth-client')
  @Roles(UserRole.SUPER_ADMIN)
  async setGDriveOAuthClient(@CurrentUser() user: User, @Body() dto: GDriveOAuthClientDto) {
    await this.gdriveOAuth.setClientConfig(dto.clientId, dto.clientSecret);
    this.audit.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'storage_backend',
      resourceId: 'gdrive_oauth_client',
      metadata: { clientIdSuffix: dto.clientId.slice(-6) },
    });
    return { message: 'Google Drive OAuth Client 已保存（secret 加密存储）' };
  }

  /** 生成授权 URL（管理员浏览器打开，授权后从回调 URL 复制 code） */
  @Post('gdrive/auth-url')
  @Roles(UserRole.SUPER_ADMIN)
  async gdriveAuthUrl(@Body() dto: GDriveAuthUrlDto) {
    const url = await this.gdriveOAuth.buildAuthUrl(dto.redirectUri);
    return { url };
  }

  /** 提交授权码：换取 refresh_token 并创建 GDrive 存储账号（创建即测试） */
  @Post('gdrive/complete-auth')
  @Roles(UserRole.SUPER_ADMIN)
  async gdriveCompleteAuth(@CurrentUser() user: User, @Body() dto: GDriveCompleteAuthDto) {
    const exchanged = await this.gdriveOAuth.exchangeCode(dto.code, dto.redirectUri);
    const account = await this.backends.create({
      type: 'gdrive',
      name: dto.name,
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

  /** 手动刷新配额（GDrive 等有配额概念的后端） */
  @Post(':id/refresh-quota')
  @Roles(UserRole.SUPER_ADMIN)
  async refreshQuota(@Param('id') id: string) {
    const quota = await this.backends.refreshQuota(id);
    return { message: quota ? '配额已刷新' : '该后端无配额概念或账号不可用', quota };
  }
}