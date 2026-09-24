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
import type { TelegramCopyOwnerType } from '../common/entities/telegram-file-copy.entity';
import { AuditService } from '../common/services/audit.service';
import { REPLICA_TARGET_CONFIG_KEY } from '../telegram-account-pool/replica-target.resolver';
import {
  isReplicationAttemptStatus,
  isUserRelayFailureReason,
} from '../telegram-account-pool/replication-attempt.service';
import { TelegramAccountsService } from './telegram-accounts.service';
import { TelegramAccountFeatureService } from './telegram-account-feature.service';
import { TelegramReplicationAuditService } from './telegram-replication-audit.service';
import { TelegramUserAuthService } from './telegram-user-auth.service';
import {
  CreateBotAccountDto,
  CreateUserAccountDto,
  RelayPreflightDto,
  ReplicationTargetDto,
  RotateAccountCredentialDto,
  SetFeatureSwitchDto,
  StartUserAuthDto,
  UpdateTelegramAccountDto,
  VerifyUserAuthDto,
} from './telegram-account.dto';

/** 轮次查询允许的归属对象类型（与 `TelegramCopyOwnerType` 同步） */
const COPY_OWNER_TYPES: TelegramCopyOwnerType[] = ['file', 'fileUnique', 'grant'];
/**
 * 轮次查询的最大返回条数（管理端更严于 `ReplicationAttemptService.listRecent` 的 500 上限：
 * 后台是人工排障场景，200 条已足够，且能约束响应体积）。
 */
const ATTEMPT_QUERY_MAX_LIMIT = 200;
/**
 * 轮次 id 必须形如 UUID。
 *
 * 为什么必须在入口校验：PG 对 uuid 列传非法字符串会抛 `22P02`，该异常会被
 * `ReplicationAttemptService.safeFind` 当作**数据库故障**并置观测降级标记，
 * 于是一次手误请求就能让后台显示「观测数据不完整」并可能触发
 * `REPLICATION_OBSERVABILITY_GAP` 告警。格式错误必须在入口 400。
 */
const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    private readonly replicationAudit: TelegramReplicationAuditService,
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

  /**
   * 副本资格审计：目标解析（configured / eligible / effective + 降级原因）、
   * 逐账号资格表、ready 覆盖率与容量策略状态。
   *
   * 必须声明在 `:id` 路由之前，否则会被当作账号 id 吞掉。
   */
  @Get('replication-audit')
  @Roles(UserRole.SUPER_ADMIN)
  async getReplicationAudit() {
    return this.replicationAudit.getReport();
  }

  /** 期望副本数热更新（写入 SystemConfig，1-8；有效目标按可承载账号数收敛） */
  @Put('replication-target')
  @Roles(UserRole.SUPER_ADMIN)
  async setReplicationTarget(@CurrentUser() user: User, @Body() dto: ReplicationTargetDto) {
    const before = await this.replicationAudit.getReport();
    const target = await this.replicationAudit.setTarget(dto.desiredReplicas);
    this.audit.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'telegram_account_pool',
      resourceId: REPLICA_TARGET_CONFIG_KEY,
      metadata: {
        previous: before.target.configured,
        configured: target.configured,
        eligibleCount: target.eligibleCount,
        effectiveTarget: target.effectiveTarget,
      },
    });
    return {
      message: `期望副本数已更新为 ${target.configured}（当前有效目标 ${target.effectiveTarget}）`,
      target,
    };
  }

  /**
   * 扩散轮次时间线（可按状态 / 失败原因 / 归属对象 / 时间窗口筛选）。
   *
   * 与 `replication-audit` 的分工：审计报告给「概览 + 最近 N 条」，
   * 这里是排障用的可筛选查询（例如「只看认领超时」「只看某个文件的失败历史」）。
   * 必须声明在 `:id` 路由之前，否则 `replication-attempts` 会被当作账号 id 吞掉。
   */
  @Get('replication-attempts')
  @Roles(UserRole.SUPER_ADMIN)
  async listReplicationAttempts(
    @Query('status') status?: string,
    @Query('failureReason') failureReason?: string,
    @Query('ownerType') ownerType?: string,
    @Query('ownerId') ownerId?: string,
    @Query('sinceMs') sinceMs?: string,
    @Query('limit') limit?: string,
  ) {
    return this.replicationAudit.listAttempts({
      status: this.parseAttemptStatus(status),
      failureReason: this.parseFailureReason(failureReason),
      ownerType: this.parseOwnerType(ownerType),
      ownerId: (ownerId || '').trim() || undefined,
      sinceMs: this.parsePositiveNumber(sinceMs, 'sinceMs'),
      limit: this.parsePositiveNumber(limit, 'limit', ATTEMPT_QUERY_MAX_LIMIT),
    });
  }

  /**
   * 单轮扩散详情：时间线 + 「为什么失败 / 影响 / 建议操作 / 是否可重试」。
   * 必须声明在 `:id` 路由之前。
   */
  @Get('replication-attempts/:attemptId')
  @Roles(UserRole.SUPER_ADMIN)
  async getReplicationAttempt(@Param('attemptId') attemptId: string) {
    return this.replicationAudit.getAttemptDetail(this.parseAttemptId(attemptId));
  }

  /**
   * 手动重试单轮扩散（**只走用户账号中继**，不提供任何策略选择项）。
   *
   * 只对「可重试失败」「认领超时」开放；配置类阻塞请先修正配置（重试也不会成功）。
   * 重试新建一轮并记录操作人，便于审计追溯；幂等键不变，不会在副本群产生重复消息。
   * 必须声明在 `:id` 路由之前。
   */
  @Post('replication-attempts/:attemptId/retry')
  @Roles(UserRole.SUPER_ADMIN)
  async retryReplicationAttempt(
    @CurrentUser() user: User,
    @Param('attemptId') attemptId: string,
  ) {
    const validatedId = this.parseAttemptId(attemptId);
    const result = await this.replicationAudit.retryAttempt(validatedId, user.id);
    this.audit.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'telegram_replication_attempt',
      resourceId: validatedId,
      metadata: {
        status: result.status,
        newAttemptId: result.attemptId,
        createdCount: result.created.length,
        missingCount: result.missing.length,
        failureReason: result.failureReason ?? null,
      },
    });
    return {
      message: result.created.length > 0
        ? `重试完成：新增 ${result.created.length} 个 ready 副本（状态 ${result.status}）`
        : `重试完成但未新增副本（状态 ${result.status}）`,
      ...result,
    };
  }

  /**
   * 中继能力预检。
   *
   * **默认 dry-run：只做只读检查，不产生任何 Telegram 消息**；
   * 只有显式传 `dryRun=false` 才发送一条受控测试消息（响应里会显式声明已产生消息）。
   * 必须声明在 `:id` 路由之前。
   */
  @Post('relay-preflight')
  @Roles(UserRole.SUPER_ADMIN)
  async relayPreflight(@CurrentUser() user: User, @Body() dto: RelayPreflightDto) {
    const report = await this.replicationAudit.runPreflight({
      dryRun: dto.dryRun !== false,
      sourceChatId: dto.sourceChatId,
      targetChatId: dto.targetChatId,
      testMessage: dto.testMessage,
    });
    this.audit.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'telegram_account_pool',
      resourceId: 'relay_preflight',
      metadata: {
        dryRun: report.dryRun,
        status: report.status,
        sentTestMessage: report.sentTestMessage,
        failedChecks: report.checks.filter((item) => item.status === 'failed').map((item) => item.id),
      },
    });
    return report;
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

  /**
   * 解析轮次状态查询参数。
   *
   * 非法值直接 400 而不是静默忽略：静默忽略会让「筛选了但看到全部」被误读成
   * 「该状态没有任何记录」，排障时得出完全相反的结论。
   */
  private parseAttemptStatus(value?: string) {
    const trimmed = (value || '').trim();
    if (!trimmed) return undefined;
    if (!isReplicationAttemptStatus(trimmed)) {
      throw new BadRequestException(`status 取值非法：${trimmed}`);
    }
    return trimmed;
  }

  /** 解析失败原因查询参数（同上：非法值 400） */
  private parseFailureReason(value?: string) {
    const trimmed = (value || '').trim();
    if (!trimmed) return undefined;
    if (!isUserRelayFailureReason(trimmed)) {
      throw new BadRequestException(`failureReason 取值非法：${trimmed}`);
    }
    return trimmed;
  }

  /** 解析归属对象类型查询参数（同上：非法值 400） */
  private parseOwnerType(value?: string) {
    const trimmed = (value || '').trim();
    if (!trimmed) return undefined;
    if (!COPY_OWNER_TYPES.includes(trimmed as TelegramCopyOwnerType)) {
      throw new BadRequestException(`ownerType 取值非法：${trimmed}`);
    }
    return trimmed as TelegramCopyOwnerType;
  }

  /** 解析正整数查询参数（缺省返回 undefined；非法或越界一律 400） */
  private parsePositiveNumber(value: string | undefined, name: string, max?: number): number | undefined {
    const trimmed = (value || '').trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new BadRequestException(`${name} 必须是正整数`);
    }
    if (max !== undefined && parsed > max) {
      throw new BadRequestException(`${name} 不能超过 ${max}`);
    }
    return parsed;
  }

  /** 校验轮次 id 格式（非法格式在入口 400，避免污染观测降级标记，见 ATTEMPT_ID_PATTERN） */
  private parseAttemptId(value: string): string {
    const trimmed = (value || '').trim();
    if (!ATTEMPT_ID_PATTERN.test(trimmed)) {
      throw new BadRequestException('扩散轮次 id 格式非法（应为 UUID）');
    }
    return trimmed;
  }
}
