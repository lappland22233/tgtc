import {
  BadRequestException,
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
import { AuditService } from '../common/services/audit.service';
import { TelegramAccountsService } from './telegram-accounts.service';
import { TelegramAccountFeatureService } from './telegram-account-feature.service';
import { TelegramUserAuthService } from './telegram-user-auth.service';
import {
  CreateBotAccountDto,
  CreateUserAccountDto,
  RotateAccountCredentialDto,
  SetFeatureSwitchDto,
  StartUserAuthDto,
  UpdateTelegramAccountDto,
  VerifyUserAuthDto,
} from './telegram-account.dto';

/**
 * Telegram 账号池管理端点（仅 SUPER_ADMIN，JWT Cookie；**不接受 API Key**）。
 *
 * 隐私与安全约定：
 * - 所有响应都是脱敏视图（`toAccountView`），不含 Token / session / API Hash / 完整手机号；
 * - 所有写操作进入审计，metadata 只记录内部 ID、类型、结果与脱敏摘要；
 * - 开关类操作写运行时配置并审计，可秒级生效，无需重启。
 */
@Controller('admin/telegram-accounts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TelegramAccountsController {
  constructor(
    private readonly accounts: TelegramAccountsService,
    private readonly feature: TelegramAccountFeatureService,
    private readonly userAuth: TelegramUserAuthService,
    private readonly audit: AuditService,
  ) {}

  /** 总览：三层开关状态、账号计数、能力前置检查结果 */
  @Get('overview')
  @Roles(UserRole.SUPER_ADMIN)
  async getOverview() {
    return this.accounts.overview();
  }

  /** 账号池总开关（关闭只阻止新任务，不中断在途流量） */
  @Put('feature')
  @Roles(UserRole.SUPER_ADMIN)
  async setFeature(@CurrentUser() user: User, @Body() dto: SetFeatureSwitchDto) {
    const before = await this.feature.getState();
    await this.feature.setAccountPoolEnabled(dto.enabled);
    const after = await this.feature.getState();
    this.audit.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'telegram_account_pool',
      resourceId: 'feature',
      metadata: {
        accountPoolEnabled: after.accountPoolEnabled,
        source: after.accountPoolSource,
        previous: before.accountPoolEnabled,
      },
    });
    return {
      message: dto.enabled
        ? '账号池已开启（仅影响新任务）'
        : '账号池已关闭（只阻止新任务，不中断已开始的传输）',
      feature: after,
    };
  }

  /** 账号列表（分页 + 类型/状态/启用/关键字筛选） */
  @Get()
  @Roles(UserRole.SUPER_ADMIN)
  async list(
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('enabled') enabled?: string,
    @Query('keyword') keyword?: string,
    @Query('includeRevoked') includeRevoked?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.accounts.list({
      type,
      status,
      enabled,
      keyword,
      // 与 enabled 同一字符串判定风格：只有显式 'true' 才算 true，其余（含 'false'/缺省）视为排除
      includeRevoked: includeRevoked === 'true',
      page: page === undefined ? undefined : Number(page),
      pageSize: pageSize === undefined ? undefined : Number(pageSize),
    });
  }

  /** 添加 Bot 账号（创建即 getMe + 主存储 Chat 校验，失败不落库） */
  @Post('bots')
  @Roles(UserRole.SUPER_ADMIN)
  async createBot(@CurrentUser() user: User, @Body() dto: CreateBotAccountDto) {
    const account = await this.accounts.createBot(dto, user.id);
    return { message: 'Bot 账号已添加', account };
  }

  /** 创建用户账号（进入待授权状态，不参与任何任务） */
  @Post('users')
  @Roles(UserRole.SUPER_ADMIN)
  async createUser(@CurrentUser() user: User, @Body() dto: CreateUserAccountDto) {
    const account = await this.accounts.createUser(dto, user.id);
    return { message: '用户账号已创建，请完成交互式授权', account };
  }

  /**
   * 重新探测**环境变量账号**（主 Bot 或 `TELEGRAM_ACCOUNT_POOL` 配置项）。
   *
   * 只读账号不提供编辑/删除/轮换（密钥只能在 `.env` 轮换），但必须能验证配置是否仍然有效。
   * 声明在 `:id` 路由之前，避免 `env` 被当作账号 id 吞掉。
   */
  @Post('env/:accountId/probe')
  @Roles(UserRole.SUPER_ADMIN)
  async probeEnvAccount(@CurrentUser() user: User, @Param('accountId') accountId: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) {
      throw new BadRequestException('环境变量账号 id 非法');
    }
    const probe = await this.accounts.probeEnvAccount(accountId, user.id);
    return { message: probe.message, probe };
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN)
  async detail(@Param('id') id: string) {
    return this.accounts.detail(id);
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN)
  async update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateTelegramAccountDto,
  ) {
    const account = await this.accounts.update(id, dto, user.id);
    return { message: '账号已更新', account };
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN)
  async remove(@CurrentUser() user: User, @Param('id') id: string) {
    const account = await this.accounts.remove(id, user.id);
    return {
      message: '账号已撤销（已清空凭据并停止参与新任务；Telegram 远端备份不会被删除）',
      account,
    };
  }

  /** 测试连接与权限（结论写入能力快照与健康字段） */
  @Post(':id/test')
  @Roles(UserRole.SUPER_ADMIN)
  async test(@CurrentUser() user: User, @Param('id') id: string) {
    const account = await this.accounts.test(id, user.id);
    return { message: '测试完成', account };
  }

  /** 轮换凭据（Bot：新 Token；用户账号：重启授权流程） */
  @Post(':id/rotate')
  @Roles(UserRole.SUPER_ADMIN)
  async rotate(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: RotateAccountCredentialDto,
  ) {
    const account = await this.accounts.findById(id);
    if (!account) throw new BadRequestException('账号不存在');
    if (account.type === 'bot') {
      if (!dto.token) throw new BadRequestException('Bot 账号轮换必须提供新的 Token');
      const updated = await this.accounts.rotateBot(id, { token: dto.token, primaryChatId: dto.primaryChatId }, user.id);
      return { message: 'Bot 凭据已轮换', account: updated };
    }
    const updated = await this.accounts.rotateUser(
      id,
      { apiId: dto.apiId, apiHash: dto.apiHash, phoneNumber: dto.phoneNumber },
      user.id,
    );
    return { message: '用户账号凭据已更新，请重新完成授权', account: updated };
  }

  /** 用户账号授权：发送验证码 */
  @Post(':id/auth/start')
  @Roles(UserRole.SUPER_ADMIN)
  async startAuth(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: StartUserAuthDto) {
    return this.userAuth.start(id, dto, user.id);
  }

  /** 用户账号授权：提交验证码（与可选 2FA 密码） */
  @Post(':id/auth/verify')
  @Roles(UserRole.SUPER_ADMIN)
  async verifyAuth(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: VerifyUserAuthDto) {
    return this.userAuth.verify(id, dto, user.id);
  }

  /** 用户账号授权：取消当前授权会话 */
  @Post(':id/auth/cancel')
  @Roles(UserRole.SUPER_ADMIN)
  async cancelAuth(@Param('id') id: string) {
    return this.userAuth.cancel(id);
  }
}
