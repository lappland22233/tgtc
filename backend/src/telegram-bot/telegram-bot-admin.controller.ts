import { Body, Controller, Get, Optional, Put, Query, Req, UseGuards } from '@nestjs/common';
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
import { TelegramAccountPoolService } from '../telegram-account-pool/telegram-account-pool.service';

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
    // 账号池只读诊断（可选依赖：未装配时接口仍可访问并给出明确原因）
    @Optional() private readonly accountPool: TelegramAccountPoolService | null = null,
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

  /** Bot 使用情况汇总（下载来自 access_logs，收到文件来自 telegram_bot_file_grants） */
  @Get('bot-usage')
  @Roles(UserRole.SUPER_ADMIN)
  async getUsage(@Query('timeRange') timeRange?: string) {
    return this.botAdminService.getUsageSummary(timeRange || '7d');
  }

  /**
   * Bot 账号池只读诊断（SUPER_ADMIN）。
   *
   * 用途：区分「服务健康」与「账号池已启用但未生效」——
   * `enabled=false` 时 `inactiveReason` 给出可诊断原因（开关未开 / 账号来源为空）。
   *
   * 安全：只返回快照（账号 `tokenPreview` 已脱敏）与进程内计数，
   * **绝不返回 Token 原文、完整 file_id 或原始 URL**；不改动 `/api/health` 形状
   * （发布健康检查脚本依赖其稳定）。
   */
  @Get('bot-account-pool')
  @Roles(UserRole.SUPER_ADMIN)
  async getAccountPoolStatus() {
    const pool = this.accountPool;
    if (!pool) {
      return {
        enabled: false,
        inactiveReason: '账号池模块未装配（TelegramAccountPoolModule 未注册）',
        counters: null,
        accounts: [],
      };
    }
    const snapshot = pool.snapshot();
    return {
      enabled: snapshot.enabled,
      inactiveReason: snapshot.inactiveReason,
      counters: snapshot.counters,
      accounts: snapshot.accounts,
    };
  }

  /**
   * Bot 用户明细：按 TG 用户 ID 聚合，直接给出 @用户名（不是昵称），
   * 支持 `keyword`（匹配用户 ID / 用户名）与 `timeRange`（默认 all）筛选及分页。
   */
  @Get('bot-usage/users')
  @Roles(UserRole.SUPER_ADMIN)
  async getBotUsers(
    @Query('keyword') keyword?: string,
    @Query('timeRange') timeRange?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.botAdminService.getUserBreakdown({ keyword, timeRange, page: Number(page), pageSize: Number(pageSize) });
  }
}
