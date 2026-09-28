import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelegramMirrorRule } from '../common/entities/telegram-mirror-rule.entity';
import { TelegramAccountError, TelegramAccountClientService } from './telegram-account-client.service';
import { TelegramAccountPoolService } from './telegram-account-pool.service';
import { TelegramUserClientService } from '../telegram-user/telegram-user-client.service';
import { UserAccountDirectoryService } from './user-account-directory.service';
import { UserRelayService } from './user-relay.service';

/**
 * 单项能力探测结论。
 *
 * 为什么必须区分 `not_checked`：把「没检查过」渲染成绿色会让运维误以为「已验证可用」。
 * 前端据此展示「未检查」（灰）而不是「通过」（绿）。
 */
export type RelayCheckStatus = 'ok' | 'failed' | 'not_checked';

/** 单次预检最多探测多少个 Bot（每个 Bot 2 次 Bot API 调用，必须设上限） */
export const RELAY_PREFLIGHT_MAX_BOTS = 10;

export interface RelayCapabilitySnapshot {
  /** 中继开关是否开启（**构造期读取**：变更后必须重启才生效） */
  relayEnabledByConfig: boolean;
  userClientAvailable: boolean;
  userClientUnavailableReason: string | null;
  /** 「已授权且启用」的用户账号数（中继选号的候选池） */
  enabledAuthorizedUserCount: number;
  /** 中继目标群（副本可见群）脱敏预览 */
  resolvedTargetChatIdPreview: string | null;
  /** 源群脱敏预览（来自启用中的镜像规则） */
  sourceChatIdPreview: string | null;
  sourceChatReadable: RelayCheckStatus;
  targetChatWritable: RelayCheckStatus;
  botsCanReceiveRelay: RelayCheckStatus;
  /** 最近一次探测时间；从未探测为 null */
  checkedAt: string | null;
  checkStatus: 'not_checked' | 'ok' | 'partial' | 'failed';
  /** 阻塞项与处理建议（脱敏，可直接展示） */
  notes: string[];
}

export interface RelayPreflightCheck {
  id: string;
  label: string;
  status: RelayCheckStatus;
  detail: string;
  advice?: string;
}

export interface RelayPreflightReport {
  dryRun: boolean;
  checkedAt: string;
  status: 'ok' | 'partial' | 'failed';
  checks: RelayPreflightCheck[];
  /** 非 dry-run 时是否真的发出了 Telegram 测试消息（必须显式告知操作人） */
  sentTestMessage: boolean;
  testMessageId: string | null;
  targetChatPreview: string | null;
  sourceChatPreview: string | null;
  notes: string[];
}

/**
 * 中继能力快照与预检服务（策略 B 的「发布前置检查」）。
 *
 * 解决什么问题：策略 B 是副本扩散的**唯一**链路，而它的前置条件分布在四处
 * （环境变量开关、MTProto 客户端、用户账号授权、源群/目标群权限与 Bot 隐私模式），
 * 任何一处不满足都表现为「后台看不到副本增长」。发布前必须能一次性回答
 * 「现在到底缺哪一项、怎么处理」，而不是逐条猜。
 *
 * 设计边界：
 * - **默认只读**：`preflight()` 默认 dry-run，不产生任何 Telegram 消息；
 *   只有显式 `dryRun=false` 才发送一条受控测试消息，并在响应里显式声明；
 * - 快照是**进程内即时观测**（单实例约束下不冒充跨重启历史指标）；
 * - 所有出参脱敏：不返回 Token、session、API Hash、完整 chat id。
 */
@Injectable()
export class RelayCapabilityService {
  private readonly logger = new Logger(RelayCapabilityService.name);

  /** 配置事实（由 `refreshFacts()` 刷新；`snapshot()` 同步读取） */
  private enabledAuthorizedUserCount = 0;
  private resolvedTargetChatId: string | null = null;
  private sourceChatId: string | null = null;
  /** 探测结论（由 `preflight()` 刷新） */
  private sourceChatReadable: RelayCheckStatus = 'not_checked';
  private targetChatWritable: RelayCheckStatus = 'not_checked';
  private botsCanReceiveRelay: RelayCheckStatus = 'not_checked';
  private checkedAtMs = 0;
  private notes: string[] = [];

  constructor(
    private readonly relay: UserRelayService,
    private readonly userClient: TelegramUserClientService,
    private readonly directory: UserAccountDirectoryService,
    private readonly pool: TelegramAccountPoolService,
    private readonly accountClient: TelegramAccountClientService,
    /** 镜像规则仓库：源群与目标群的事实来源（与 `UserRelayService` 同一张表） */
    @Optional() @InjectRepository(TelegramMirrorRule)
    private readonly rules: Repository<TelegramMirrorRule> | null = null,
  ) {}

  /**
   * 刷新配置事实（用户账号数 / 目标群 / 源群）。
   *
   * 为什么单独拆出来：`snapshot()` 需要同步（供审计报告与告警评估直接读取），
   * 而这三项都是异步查询；由调用方在合适的时机（管理端请求、告警采集）显式刷新。
   * 全部走各自服务的缓存，重复调用代价可忽略。
   */
  async refreshFacts(): Promise<void> {
    try {
      const accounts = await this.directory.listEnabled();
      this.enabledAuthorizedUserCount = accounts.length;
    } catch (error) {
      this.logger.debug(`用户账号数读取失败（沿用上次结果）：${this.describe(error)}`);
    }
    try {
      this.resolvedTargetChatId = (await this.relay.resolveTargetChatId()) || null;
    } catch (error) {
      this.logger.debug(`中继目标群读取失败（沿用上次结果）：${this.describe(error)}`);
    }
    if (this.rules) {
      try {
        const rule = await this.rules.findOne({ where: { enabled: true } });
        this.sourceChatId = (rule?.sourceChatId || '').trim() || null;
      } catch (error) {
        this.logger.debug(`镜像规则源群读取失败（沿用上次结果）：${this.describe(error)}`);
      }
    }
  }

  /** 能力快照（同步；调用前先 `refreshFacts()` 才是最新事实） */
  snapshot(): RelayCapabilitySnapshot {
    const relayEnabledByConfig = this.relay.isEnabledByConfig();
    const userClientAvailable = this.userClient.isAvailable();
    const checks: RelayCheckStatus[] = [
      this.sourceChatReadable,
      this.targetChatWritable,
      this.botsCanReceiveRelay,
    ];
    return {
      relayEnabledByConfig,
      userClientAvailable,
      userClientUnavailableReason: this.userClient.unavailableReason(),
      enabledAuthorizedUserCount: this.enabledAuthorizedUserCount,
      resolvedTargetChatIdPreview: this.maskChatId(this.resolvedTargetChatId),
      sourceChatIdPreview: this.maskChatId(this.sourceChatId),
      sourceChatReadable: this.sourceChatReadable,
      targetChatWritable: this.targetChatWritable,
      botsCanReceiveRelay: this.botsCanReceiveRelay,
      checkedAt: this.checkedAtMs > 0 ? new Date(this.checkedAtMs).toISOString() : null,
      checkStatus: this.checkedAtMs === 0
        ? 'not_checked'
        : checks.every((item) => item === 'ok')
          ? 'ok'
          : checks.some((item) => item === 'ok')
            ? 'partial'
            : 'failed',
      notes: [...this.notes],
    };
  }

  /**
   * 中继预检。
   *
   * `dryRun=true`（默认）：只做只读检查，**不产生任何 Telegram 消息**——
   * Bot API 的 `getMe` / `getChatMember` 与 MTProto 的 chat 解析都不发送消息。
   * `dryRun=false`：额外用第一个可用 Bot 向目标群发一条受控测试消息，
   * 用于验证「用户账号可写 + 群存在 + 未被封禁」这条组合事实。
   */
  async preflight(params: {
    dryRun?: boolean;
    /** 覆盖源群（默认取启用中镜像规则的源群） */
    sourceChatId?: string;
    /** 覆盖目标群（默认取启用中镜像规则的目标群） */
    targetChatId?: string;
    /** 测试消息文本（仅非 dry-run 时使用） */
    testMessage?: string;
  } = {}): Promise<RelayPreflightReport> {
    const dryRun = params.dryRun !== false;
    await this.refreshFacts();
    const targetChatId = (params.targetChatId || '').trim() || this.resolvedTargetChatId || '';
    const sourceChatId = (params.sourceChatId || '').trim() || this.sourceChatId || '';
    const checks: RelayPreflightCheck[] = [];
    const notes: string[] = [];

    // 1) 开关（构造期读取，必须重启才生效——这是运维最容易踩的坑）
    const relayEnabled = this.relay.isEnabledByConfig();
    checks.push({
      id: 'config',
      label: '中继开关',
      status: relayEnabled ? 'ok' : 'failed',
      detail: relayEnabled
        ? 'TELEGRAM_USER_RELAY_ENABLED=true（构造期读取，变更后需重启后端）'
        : 'TELEGRAM_USER_RELAY_ENABLED 未开启',
      advice: relayEnabled
        ? undefined
        : '在部署环境配置 TELEGRAM_USER_RELAY_ENABLED=true 并重启后端（不支持热开启）',
    });

    // 2) MTProto 客户端
    const clientAvailable = this.userClient.isAvailable();
    checks.push({
      id: 'user_client',
      label: 'MTProto 客户端',
      status: clientAvailable ? 'ok' : 'failed',
      detail: clientAvailable
        ? '客户端可加载'
        : `客户端不可用：${this.userClient.unavailableReason() ?? '未知原因'}`,
      advice: clientAvailable ? undefined : '检查后端依赖安装与启动日志中的客户端初始化错误',
    });

    // 3) 用户账号
    const accountCount = this.enabledAuthorizedUserCount;
    checks.push({
      id: 'user_accounts',
      label: '可用用户账号',
      status: accountCount > 0 ? 'ok' : 'failed',
      detail: accountCount > 0 ? `${accountCount} 个「已授权且启用」的用户账号` : '没有可用的用户账号',
      advice: accountCount > 0
        ? undefined
        : '在「账号管理」新增用户账号并完成交互式授权，然后启用该账号',
    });

    // 4) 目标群（副本可见群）：唯一权威是启用中的镜像规则
    checks.push({
      id: 'target_chat',
      label: '目标群（副本可见群）',
      status: targetChatId ? 'ok' : 'failed',
      detail: targetChatId
        ? `已解析到目标群 ${this.maskChatId(targetChatId)}`
        : '没有启用中的镜像规则目标群',
      advice: targetChatId
        ? undefined
        : '在镜像规则中配置并启用目标群（归档群不再作为回退目标）',
    });

    // 5) 源群可读（MTProto 只读校验）
    const sourceReadable = await this.checkSourceChat(sourceChatId);
    checks.push(sourceReadable);
    this.sourceChatReadable = sourceReadable.status;

    // 6) 目标群内 Bot 是否都能收到用户账号发出的消息
    const bots = await this.checkBotsCanReceive(targetChatId);
    checks.push(bots);
    this.botsCanReceiveRelay = bots.status;

    // 7) 目标群可写：dry-run 下**不做**（发消息才有副作用）
    let sentTestMessage = false;
    let testMessageId: string | null = null;
    if (dryRun) {
      this.targetChatWritable = 'not_checked';
      checks.push({
        id: 'target_chat_writable',
        label: '目标群可写',
        status: 'not_checked',
        detail: 'dry-run 未发送测试消息，无法验证可写性',
        advice: '需要验证时以 dryRun=false 重新探测（会向目标群发送一条测试消息）',
      });
    } else {
      const writable = await this.sendTestMessage(targetChatId, params.testMessage);
      sentTestMessage = writable.sent;
      testMessageId = writable.messageId;
      this.targetChatWritable = writable.status;
      checks.push(writable.check);
    }

    this.checkedAtMs = Date.now();
    this.notes = notes.concat(
      checks.filter((item) => item.status === 'failed').map((item) => `${item.label}：${item.detail}`),
    );

    const status: RelayPreflightReport['status'] = checks.some((item) => item.status === 'failed')
      ? (checks.some((item) => item.status === 'ok') ? 'partial' : 'failed')
      : 'ok';

    return {
      dryRun,
      checkedAt: new Date(this.checkedAtMs).toISOString(),
      status,
      checks,
      sentTestMessage,
      testMessageId,
      targetChatPreview: this.maskChatId(targetChatId),
      sourceChatPreview: this.maskChatId(sourceChatId),
      notes: [...this.notes],
    };
  }

  /** 源群可读性（MTProto 只读：解析 chat 实体，不发送任何消息） */
  private async checkSourceChat(sourceChatId: string): Promise<RelayPreflightCheck> {
    if (!sourceChatId) {
      return {
        id: 'source_chat_readable',
        label: '源群可读',
        status: 'failed',
        detail: '没有可用的源群（启用中的镜像规则未配置源群）',
        advice: '在镜像规则中配置源群；Bot 私聊来源需先经源消息准备链路进入可读群',
      };
    }
    if (!this.userClient.isAvailable()) {
      return {
        id: 'source_chat_readable',
        label: '源群可读',
        status: 'not_checked',
        detail: 'MTProto 客户端不可用，无法校验源群可读性',
      };
    }
    const accounts = await this.directory.listEnabled();
    if (accounts.length === 0) {
      return {
        id: 'source_chat_readable',
        label: '源群可读',
        status: 'not_checked',
        detail: '没有可用用户账号，无法校验源群可读性',
      };
    }
    const chosen = accounts[0];
    try {
      const access = await this.userClient.checkChatAccess({
        apiId: chosen.apiId,
        apiHash: chosen.apiHash,
        session: chosen.session,
      }, sourceChatId);
      return {
        id: 'source_chat_readable',
        label: '源群可读',
        status: 'ok',
        detail: `账号 ${chosen.id} 可访问 ${this.maskChatId(sourceChatId)}（${access.type || '未知类型'}）`,
      };
    } catch (error) {
      return {
        id: 'source_chat_readable',
        label: '源群可读',
        status: 'failed',
        detail: `账号 ${chosen.id} 无法读取源群：${this.describe(error)}`,
        advice: '确认用户账号已加入源群；Bot 私聊来源需先经源消息准备链路进入可读群',
      };
    }
  }

  /**
   * 目标群内 Bot 接收能力。
   *
   * 两项硬事实缺一不可：
   * 1. Bot 的 `can_read_all_group_messages=true`（否则收不到用户账号发的普通群消息）；
   * 2. Bot 是目标群成员（否则连认领的机会都没有）。
   * 只检查前 N 个启用账号（每个 2 次 API 调用，必须设上限）。
   */
  private async checkBotsCanReceive(targetChatId: string): Promise<RelayPreflightCheck> {
    const bots = this.pool.snapshot().accounts.filter((account) => account.enabled).slice(0, RELAY_PREFLIGHT_MAX_BOTS);
    if (!targetChatId) {
      return {
        id: 'bots_can_receive',
        label: 'Bot 可接收中继消息',
        status: 'not_checked',
        detail: '没有目标群，无法校验 Bot 接收能力',
      };
    }
    if (bots.length === 0) {
      return {
        id: 'bots_can_receive',
        label: 'Bot 可接收中继消息',
        status: 'not_checked',
        detail: '账号池内没有启用的 Bot 账号',
      };
    }

    const failures: string[] = [];
    let checked = 0;
    for (const bot of bots) {
      const config = this.pool.getConfig(bot.id);
      if (!config?.token) continue;
      const me = await this.accountClient.getMeInfo(bot.id, config.token);
      if (!me.ok) {
        failures.push(`${bot.id}：getMe 失败`);
        continue;
      }
      if (me.canReadAllGroupMessages === false) {
        failures.push(`${bot.id}：隐私模式未关闭（收不到用户账号发出的群消息）`);
        continue;
      }
      if (!me.botId) {
        failures.push(`${bot.id}：无法解析 Bot ID`);
        continue;
      }
      try {
        const member = await this.accountClient.getChatMember(bot.id, config.token, targetChatId, me.botId);
        if (!member.status || member.status === 'left' || member.status === 'kicked') {
          failures.push(`${bot.id}：不在目标群内（status=${member.status || 'unknown'}）`);
          continue;
        }
        checked += 1;
      } catch (error) {
        const kind = error instanceof TelegramAccountError ? error.kind : 'other';
        // getChatMember 的 400（chat not found / user not participant）通常就是「Bot 不在群里」
        failures.push(`${bot.id}：成员查询失败（${kind}），通常表示该 Bot 不在目标群内`);
      }
    }

    if (failures.length === 0) {
      return {
        id: 'bots_can_receive',
        label: 'Bot 可接收中继消息',
        status: 'ok',
        detail: `${checked} 个 Bot 均已加入目标群且关闭隐私模式（或已设为管理员）`,
      };
    }
    return {
      id: 'bots_can_receive',
      label: 'Bot 可接收中继消息',
      // 只要有一个 Bot 不满足条件，这条检查就是「不通过」（聚合快照里的 `partial`
      // 表示「部分检查未通过」，与此处单条检查的取值口径不同）。
      status: 'failed',
      detail: `${failures.length} 个 Bot 不满足接收条件：${failures.slice(0, 5).join('；')}`,
      advice: '把对应 Bot 加入目标群，并在 BotFather 关闭隐私模式（或将其设为群管理员）',
    };
  }

  /** 目标群可写性：非 dry-run 才执行（会向目标群发送一条测试消息） */
  private async sendTestMessage(
    targetChatId: string,
    testMessage?: string,
  ): Promise<{ check: RelayPreflightCheck; status: RelayCheckStatus; sent: boolean; messageId: string | null }> {
    const base = { id: 'target_chat_writable', label: '目标群可写' };
    if (!targetChatId) {
      return {
        check: { ...base, status: 'failed', detail: '没有目标群，无法验证可写性' },
        status: 'failed',
        sent: false,
        messageId: null,
      };
    }
    const bot = this.pool.snapshot().accounts.find((account) => account.enabled);
    const config = bot ? this.pool.getConfig(bot.id) : null;
    if (!config?.token) {
      return {
        check: { ...base, status: 'not_checked', detail: '账号池内没有可用 Bot 账号，无法发送测试消息' },
        status: 'not_checked',
        sent: false,
        messageId: null,
      };
    }
    const text = (testMessage || '').trim()
      || '【副本扩散预检】这是一条受控测试消息，用于验证目标群可写性。可忽略。';
    try {
      await this.accountClient.sendMessage(bot!.id, config.token, targetChatId, text, { disableNotification: true });
      return {
        check: {
          ...base,
          status: 'ok',
          detail: `已由 Bot ${bot!.id} 向目标群 ${this.maskChatId(targetChatId)} 发送测试消息（已产生 Telegram 消息）`,
        },
        status: 'ok',
        sent: true,
        messageId: null,
      };
    } catch (error) {
      const kind = error instanceof TelegramAccountError ? error.kind : 'other';
      return {
        check: {
          ...base,
          status: 'failed',
          detail: `Bot ${bot!.id} 无法向目标群发送消息（${kind}）：${this.describe(error)}`,
          advice: '确认 Bot 已被加入目标群且具备发送权限（未被禁言/未被限制）',
        },
        status: 'failed',
        sent: false,
        messageId: null,
      };
    }
  }

  /** chat id 脱敏（只保留末 4 位） */
  private maskChatId(chatId: string | null): string | null {
    const trimmed = (chatId || '').trim();
    if (!trimmed) return null;
    if (trimmed.length <= 4) return '***';
    return `***${trimmed.slice(-4)}`;
  }

  private describe(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 200);
  }
}
