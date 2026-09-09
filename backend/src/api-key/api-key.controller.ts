import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import { ApiKeyService } from './api-key.service';
import { ApiKeyUsageService } from './api-key-usage.service';
import { CreateApiKeyDto, RotateApiKeyDto, SetApiKeyAllowlistDto } from './api-key.dto';

/**
 * API 密钥管理控制器。
 *
 * 路由（全局前缀 /api）：
 * - POST   /api-keys                      创建密钥（明文仅本次响应返回）
 * - GET    /api-keys                      列出我的密钥（仅元信息）
 * - DELETE /api-keys/:id                  撤销密钥（即时失效，幂等）
 * - POST   /api-keys/:id/rotate           轮换密钥（撤销旧密钥并签发新明文）
 * - GET    /api-keys/:id/reveal           所有者重显完整明文（v1.2.6，仅新密钥）
 * - GET    /api-keys/:id/allowlist        查询密钥 IP 白名单（v1.2.6）
 * - PUT    /api-keys/:id/allowlist        全量替换密钥 IP 白名单（v1.2.6）
 * - GET    /api-keys/:id/usage-logs       所有者审计密钥使用记录（IP 脱敏，v1.2.6）
 * - GET    /api-keys/admin/usage-logs     管理员审计使用记录（完整 IP，v1.2.6）
 *
 * 管理接口仅接受 JWT 登录会话（不接受 API Key 自身认证），
 * 且只能操作当前登录账号自己的密钥。
 */
@Controller('api-keys')
@UseGuards(JwtAuthGuard)
export class ApiKeyController {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly usageService: ApiKeyUsageService,
  ) {}

  @Post()
  async create(@CurrentUser() user: User, @Body() dto: CreateApiKeyDto) {
    return this.apiKeyService.create(user, dto.name);
  }

  @Get()
  async list(@CurrentUser() user: User) {
    return { keys: await this.apiKeyService.list(user) };
  }

  /** 管理员审计全部使用记录（完整可信 IP，不脱敏）。必须先于 :id/ 路由声明。 */
  @Get('admin/usage-logs')
  async adminUsageLogs(
    @CurrentUser() user: User,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('userId') userId?: string,
  ) {
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('仅管理员可访问');
    }
    return this.usageService.listForAdmin(Number(page) || 1, Number(limit) || 50, userId || undefined);
  }

  @Delete(':id')
  async revoke(@Param('id') id: string, @CurrentUser() user: User) {
    await this.apiKeyService.revoke(user, id);
    return { message: 'API 密钥已撤销' };
  }

  @Post(':id/rotate')
  async rotate(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() dto: RotateApiKeyDto,
  ) {
    return this.apiKeyService.rotate(user, id, dto.name);
  }

  /** 所有者重显完整明文（响应禁止缓存；仅登录会话） */
  @Get(':id/reveal')
  async reveal(@Param('id') id: string, @CurrentUser() user: User) {
    const result = await this.apiKeyService.reveal(user, id);
    return { key: result.key };
  }

  @Get(':id/allowlist')
  async getAllowlist(@Param('id') id: string, @CurrentUser() user: User) {
    return this.apiKeyService.getAllowlist(user, id);
  }

  @Put(':id/allowlist')
  async setAllowlist(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() dto: SetApiKeyAllowlistDto,
  ) {
    return this.apiKeyService.setAllowlist(user, id, dto.rules || []);
  }

  /** 所有者审计自己的密钥使用记录（IP 脱敏：仅首段 + 末段） */
  @Get(':id/usage-logs')
  async usageLogs(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.usageService.listForKey(
      user,
      id,
      Number(page) || 1,
      Number(limit) || 20,
    );
  }
}
