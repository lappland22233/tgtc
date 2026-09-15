import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import { AuditService } from '../common/services/audit.service';
import { TelegramBotConfigService } from './telegram-bot-config.service';
import { TelegramBotAdminService } from './telegram-bot-admin.service';
import { TelegramBotTokenCryptoService } from './telegram-bot-token-crypto.service';
import { UpdateBotConfigDto } from './telegram-bot.dto';
import { TelegramBotRuntimeConfig } from './telegram-bot.types';

/**
 * Telegram Bot 管理端点（仅 SUPER_ADMIN）。
 *
 * 注意：不走 admin.service 的通用配置入口（GENERIC_CONFIG_KEY_WHITELIST /
 * SEC_CONFIG_META），避免绕过专用校验（见计划 5.8）。
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TelegramBotAdminController {
  constructor(
    private readonly botConfigService: TelegramBotConfigService,
    private readonly botAdminService: TelegramBotAdminService,
    private readonly tokenCryptoService: TelegramBotTokenCryptoService,
    private readonly auditService: AuditService,
  ) {}

  /** 读取 Bot 配置 + 当前生效域名（便于面板展示） */
  @Get('bot-config')
  @Roles(UserRole.SUPER_ADMIN)
  async getConfig(@Req() req: Request) {
    const config = await this.botConfigService.getConfig();
    const effectiveDomain = await this.botConfigService.resolveSiteOriginAsync(req);
    const detected = this.botConfigService.detectDomainFromRequest(req);
    return {
      config,
      effectiveDomain,
      detectedDomain: detected,
      cryptoAvailable: this.tokenCryptoService.isAvailable(),
    };
  }

  /** 更新 Bot 配置（热更新，无需重启），变更全审计 */
  @Put('bot-config')
  @Roles(UserRole.SUPER_ADMIN)
  async updateConfig(@CurrentUser() user: User, @Body() dto: UpdateBotConfigDto) {
    const before = await this.botConfigService.getConfig();
    const next = await this.botConfigService.updateConfig(dto as Partial<TelegramBotRuntimeConfig>);
    this.auditService.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'bot_config',
      resourceId: 'telegram_bot',
      metadata: {
        // 不记录敏感明文；仅记录变更键与前后值（均为非敏感配置）
        changed: Object.keys(dto),
        before,
        after: next,
      },
    });
    return { message: 'Bot 配置已更新', config: next };
  }

  /** 候选站点域名探测（与解析优先级一致：APP_URL 优先，不采信裸 Host 头） */
  @Get('bot-config/detected-domain')
  @Roles(UserRole.SUPER_ADMIN)
  async getDetectedDomain(@Req() req: Request) {
    const detected = this.botConfigService.detectDomainFromRequest(req);
    return { detectedDomain: detected };
  }

  /** Bot 使用情况汇总（基于 access_logs，SQL 侧聚合） */
  @Get('bot-usage')
  @Roles(UserRole.SUPER_ADMIN)
  async getUsage(@Query('timeRange') timeRange?: string) {
    return this.botAdminService.getUsageSummary(timeRange || '7d');
  }
}
