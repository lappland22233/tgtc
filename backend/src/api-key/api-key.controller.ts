import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../common/entities/user.entity';
import { ApiKeyService } from './api-key.service';
import { CreateApiKeyDto, RotateApiKeyDto } from './api-key.dto';

/**
 * API 密钥管理控制器。
 *
 * 路由（全局前缀 /api）：
 * - POST   /api-keys            创建密钥（明文仅本次响应返回）
 * - GET    /api-keys            列出我的密钥（仅元信息）
 * - DELETE /api-keys/:id        撤销密钥（即时失效，幂等）
 * - POST   /api-keys/:id/rotate 轮换密钥（撤销旧密钥并签发新明文）
 *
 * 管理接口仅接受 JWT 登录会话（不接受 API Key 自身认证），
 * 且只能操作当前登录账号自己的密钥。
 */
@Controller('api-keys')
@UseGuards(JwtAuthGuard)
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Post()
  async create(@CurrentUser() user: User, @Body() dto: CreateApiKeyDto) {
    return this.apiKeyService.create(user, dto.name);
  }

  @Get()
  async list(@CurrentUser() user: User) {
    return { keys: await this.apiKeyService.list(user) };
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
}
