import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import { AuditService } from '../common/services/audit.service';
import { TelegramAccountFeatureService } from '../telegram-accounts/telegram-account-feature.service';
import { TelegramAccountsService } from '../telegram-accounts/telegram-accounts.service';
import { StartBackfillDto, UpdateMirrorRuleDto } from './telegram-mirror.dto';
import { TelegramMirrorBackfillService } from './telegram-mirror-backfill.service';
import { SetFeatureSwitchDto } from '../telegram-accounts/telegram-account.dto';
import { TelegramMirrorConfigService } from './telegram-mirror-config.service';
import { TelegramMirrorTaskService } from './telegram-mirror-task.service';
import { TelegramMirrorMetricsService } from './telegram-mirror-metrics.service';
import { TelegramMirrorTriggerService } from './telegram-mirror-trigger.service';
import { MirrorTaskListItem } from './telegram-mirror.types';

/**
 * 镜像备份管理端点（仅 SUPER_ADMIN，JWT Cookie；不接受 API Key）。
 *
 * 三层开关的第二、三层由本控制器管理：镜像功能总开关（运行时配置）与规则启用状态；
 * 全局账号池开关在 `/admin/telegram-accounts/feature`。
 */
@Controller('admin/telegram-mirror')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TelegramMirrorController {
  constructor(
    private readonly config: TelegramMirrorConfigService,
    private readonly tasks: TelegramMirrorTaskService,
    private readonly metrics: TelegramMirrorMetricsService,
    private readonly feature: TelegramAccountFeatureService,
    private readonly accounts: TelegramAccountsService,
    private readonly backfill: TelegramMirrorBackfillService,
    private readonly audit: AuditService,
    private readonly trigger: TelegramMirrorTriggerService,
  ) {}

  /** 镜像配置总览：规则列表、任务概览、指标与前置检查 */
  @Get()
  @Roles(UserRole.SUPER_ADMIN)
  async overview() {
    const [rules, taskSummary, feature, accountOverview, botAccounts] = await Promise.all([
      this.config.listRules(),
      this.tasks.summary(),
      this.feature.getState(),
      this.accounts.overview(),
      this.accounts.list({ type: 'bot', pageSize: 100 }),
    ]);
    const enabledRules = rules.filter((item) => item.enabled);
    const mainChatIds = Array.from(new Set(
      enabledRules.map((item) => (item.sourceChatId || '').trim()).filter((id) => id.length > 0),
    ));

    // 真实校验「镜像群不得是任一 Bot 账号的主存储 Chat」——不能只依赖写规则时的校验，
    // 否则账号主存储 Chat 后改、规则未改时，面板预检会给出「通过」的假安全感。
    const storageChats = new Set(
      botAccounts.items.map((item) => (item.primaryChatId || '').trim()).filter((id) => id.length > 0),
    );
    const conflictingRule = rules.find((item) => storageChats.has((item.targetChatId || '').trim()));

    const precheck: Array<{ id: string; ok: boolean; hint: string }> = [
      {
        id: 'rule_configured',
        ok: rules.length > 0 && rules.every((item) => Boolean(item.sourceChatId && item.targetChatId)),
        hint: '每条规则都必须配置主群（源群，中转落点）与镜像群（备份群）',
      },
      {
        id: 'source_target_distinct',
        ok: rules.length > 0 && rules.every((item) => item.sourceChatId !== item.targetChatId),
        hint: '主群与镜像群必须不同，中转落点与备份必须分离',
      },
      {
        id: 'main_chat_shared',
        ok: mainChatIds.length <= 1,
        hint: '所有**启用中**的规则必须共用同一个主群（源群），否则同一文件会被搬运多次',
      },
      {
        id: 'target_not_storage_chat',
        ok: !conflictingRule,
        hint: '镜像群不得是任一 Bot 账号的主存储 Chat（会造成消息归属与清理语义混淆）',
      },
      {
        id: 'permission_tested',
        ok: enabledRules.length > 0 && enabledRules.every((item) => item.lastTestStatus === 'ok'),
        hint: '启用规则前必须通过一次主群/镜像群权限测试',
      },
      {
        id: 'accounts_available',
        ok: accountOverview.counts.enabled > 0,
        hint: '至少需要一个已启用账号（Bot 负责搬运到主群与副本认领；用户账号负责中继）',
      },
      {
        id: 'user_client_available',
        ok: accountOverview.userClientAvailable,
        hint: 'MTProto 客户端不可用时用户账号无法中继（扩散会 fail-closed，不降级为二次上传）',
      },
    ];

    return {
      rules,
      // 兼容旧字段：概览页此前只认单条规则
      rule: rules.find((item) => item.enabled) ?? rules[rules.length - 1] ?? null,
      enabledRuleCount: enabledRules.length,
      mainChatId: mainChatIds[0] ?? null,
      tasks: taskSummary,
      metrics: this.metrics.snapshot(),
      feature: {
        mirrorEnabled: feature.mirrorEnabled,
        source: feature.mirrorSource,
        forceDisabled: feature.mirrorForceDisabled,
      },
      precheck,
      notes: [
        '扩散链路唯一：持有源消息的 Bot 先转发到主群，再由用户账号从主群服务端转发到各镜像群。',
        '全程只做服务端转发（零字节重传），不存在「Bot 重新上传到镜像群」的路径，也不作为失败降级。',
        '转发成功只是中间态：镜像群内每个 Bot 认领到自己的 file_id 副本后，扩散才算完成。',
        '关闭镜像开关只阻止新任务，不中断已开始的转发，也不删除已备份内容。',
      ],
    };
  }

  /** 新建规则（初始停用；源/镜像群变更后必须重新通过权限测试才能启用） */
  @Post('rules')
  @Roles(UserRole.SUPER_ADMIN)
  async createRule(@CurrentUser() user: User, @Body() dto: UpdateMirrorRuleDto) {
    const rule = await this.config.create(dto, user.id);
    return { message: '镜像规则已创建（默认停用，请先执行权限测试再启用）', rule };
  }

  /** 更新指定规则 */
  @Put('rules/:id')
  @Roles(UserRole.SUPER_ADMIN)
  async updateRule(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: UpdateMirrorRuleDto) {
    const rule = await this.config.updateRule(id, dto, user.id);
    return { message: '镜像规则已更新（主群/镜像群变更后需重新执行权限测试才能启用）', rule };
  }

  /** 删除规则（启用中或有在途任务时拒绝，避免在途扩散静默中断） */
  @Delete('rules/:id')
  @Roles(UserRole.SUPER_ADMIN)
  async removeRule(@CurrentUser() user: User, @Param('id') id: string) {
    await this.config.removeRule(id, user.id);
    return { message: '镜像规则已删除' };
  }

  /** 镜像功能总开关（关闭只阻止新任务） */
  @Put('feature')
  @Roles(UserRole.SUPER_ADMIN)
  async setFeature(@CurrentUser() user: User, @Body() dto: SetFeatureSwitchDto) {
    await this.feature.setMirrorEnabled(dto.enabled);
    this.audit.log({
      action: dto.enabled ? 'telegram_mirror_feature_enabled' : 'telegram_mirror_feature_disabled',
      userId: user.id,
      resourceType: 'telegram_mirror_feature',
      resourceId: 'feature',
      metadata: { mirrorEnabled: dto.enabled },
    });
    return {
      message: dto.enabled
        ? '镜像功能已开启（仅影响新任务；未完成的任务会在下一轮对账中重新入队）'
        : '镜像功能已关闭（只阻止新任务，已开始的镜像会正常收尾）',
    };
  }

  /** 启用/停用指定规则（启用前必须通过权限测试，且主群与其它启用规则一致） */
  @Put('rules/:id/enabled')
  @Roles(UserRole.SUPER_ADMIN)
  async setRuleEnabled(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: SetFeatureSwitchDto) {
    const rule = await this.config.setEnabled(id, dto.enabled, user.id);
    return { message: dto.enabled ? '镜像规则已启用' : '镜像规则已停用', rule };
  }

  /** 权限测试（真实探测主群/镜像群可达性，不产生真实镜像任务） */
  @Post('rules/:id/test')
  @Roles(UserRole.SUPER_ADMIN)
  async testRule(@CurrentUser() user: User, @Param('id') id: string) {
    return this.config.testRule(id, user.id);
  }

  /**
   * 对指定 Bot 直链 grant 补触发镜像任务。
   * 用途：规则此前关闭 Bot 入站、grant 已存在但未建任务；由管理员在部署/规则修复后
   * 对受控 canary grant 调用，不批量扫描或重放全部历史私聊文件。
   */
  @Post('grants/:id/retry')
  @Roles(UserRole.SUPER_ADMIN)
  async retryGrant(@CurrentUser() user: User, @Param('id', new ParseUUIDPipe()) id: string) {
    const result = await this.trigger.retryForOwner({
      ownerType: 'grant',
      ownerId: id,
      operatorUserId: user.id,
    });
    this.audit.log({
      action: 'telegram_mirror_task_retried',
      userId: user.id,
      resourceType: 'telegram_bot_grant',
      resourceId: id,
      metadata: result,
    });
    return {
      message: `Bot 直链扩散任务处理完成（补建 ${result.created}，重排 ${result.requeued}，跳过已成功 ${result.skippedSucceeded}）`,
      ...result,
    };
  }

  /** 任务列表（按状态/模式/文件/账号筛选） */
  @Get('tasks')
  @Roles(UserRole.SUPER_ADMIN)
  async listTasks(
    @Query('status') status?: string,
    @Query('mode') mode?: string,
    @Query('ownerId') ownerId?: string,
    @Query('accountId') accountId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const { items, total } = await this.tasks.list({
      status,
      mode,
      ownerId,
      accountId,
      page: page === undefined ? undefined : Number(page),
      pageSize: pageSize === undefined ? undefined : Number(pageSize),
    });
    return { items: items.map(toTaskListItem), total };
  }

  /** 手动重试失败/阻塞/取消的任务 */
  @Post('tasks/:id/retry')
  @Roles(UserRole.SUPER_ADMIN)
  async retryTask(@CurrentUser() user: User, @Param('id') id: string) {
    const task = await this.tasks.retry(id, user.id);
    return { message: '任务已重新入队', task: toTaskListItem(task) };
  }

  /** 取消尚未开始的任务（执行中的任务不允许中断，避免产生半个备份） */
  @Post('tasks/:id/cancel')
  @Roles(UserRole.SUPER_ADMIN)
  async cancelTask(@CurrentUser() user: User, @Param('id') id: string) {
    const task = await this.tasks.cancel(id, user.id);
    return { message: '任务已取消', task: toTaskListItem(task) };
  }

  /**
   * 历史文件补偿镜像（阶段 3，P1）。
   *
   * 限速与安全约定：按批扫描（每批 20 个文件、批间隔 1s）并可在任意时刻暂停/取消；
   * 已存在任务的文件会被跳过（幂等键保证重复运行不产生重复备份）；
   * `dry-run` 只统计影响面并把样本文件 ID 返回给管理员评估。
   */
  @Post('backfill')
  @Roles(UserRole.SUPER_ADMIN)
  async startBackfill(@CurrentUser() user: User, @Body() dto: StartBackfillDto) {
    const job = await this.backfill.start(dto, user.id);
    return {
      message: dto.mode === 'dry-run'
        ? '历史补偿评估已启动（仅统计，不入队）'
        : '历史补偿已启动（按批限速入队，可随时暂停或取消）',
      job,
    };
  }

  @Get('backfill')
  @Roles(UserRole.SUPER_ADMIN)
  async backfillStatus() {
    return { job: this.backfill.status() };
  }

  @Post('backfill/pause')
  @Roles(UserRole.SUPER_ADMIN)
  async pauseBackfill() {
    return { message: '历史补偿已暂停', job: this.backfill.pause() };
  }

  @Post('backfill/resume')
  @Roles(UserRole.SUPER_ADMIN)
  async resumeBackfill(@CurrentUser() user: User) {
    return { message: '历史补偿已恢复', job: this.backfill.resume(user.id) };
  }

  @Post('backfill/cancel')
  @Roles(UserRole.SUPER_ADMIN)
  async cancelBackfill() {
    return { message: '历史补偿已取消（已入队的任务仍会按规则执行）', job: this.backfill.cancel() };
  }
}

/** 任务列表项：只暴露运维需要的字段（不含敏感信息） */
function toTaskListItem(task: {
  id: string;
  ruleId: string;
  ownerType: string;
  ownerId: string;
  sourceVersion: number;
  mode: string;
  status: string;
  attempts: number;
  sourceAccountId: string | null;
  targetAccountId: string | null;
  targetChatId: string | null;
  targetMessageId: string | null;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  nextRetryAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): MirrorTaskListItem {
  if (!task.ownerId) throw new BadRequestException('任务数据不完整');
  return {
    id: task.id,
    ruleId: task.ruleId,
    ownerType: task.ownerType,
    ownerId: task.ownerId,
    sourceVersion: Number(task.sourceVersion),
    mode: task.mode,
    status: task.status as MirrorTaskListItem['status'],
    attempts: Number(task.attempts),
    sourceAccountId: task.sourceAccountId ?? null,
    targetAccountId: task.targetAccountId ?? null,
    targetChatId: task.targetChatId ?? null,
    targetMessageId: task.targetMessageId ?? null,
    fileName: null,
    lastErrorCode: task.lastErrorCode ?? null,
    lastErrorSummary: task.lastErrorSummary ?? null,
    nextRetryAt: task.nextRetryAt ? new Date(task.nextRetryAt).toISOString() : null,
    startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
    completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : null,
    createdAt: new Date(task.createdAt).toISOString(),
    updatedAt: new Date(task.updatedAt).toISOString(),
  };
}
