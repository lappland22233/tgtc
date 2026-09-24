import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelegramMirrorRule } from '../common/entities/telegram-mirror-rule.entity';
import type { UserRelayFailureReason } from '../common/entities/telegram-replication-attempt.entity';
import {
  TelegramUserClientError,
  TelegramUserClientService,
  TelegramUserFailureKind,
} from '../telegram-user/telegram-user-client.service';
import { TelegramAccountPoolService } from './telegram-account-pool.service';
import { UserAccountDirectoryService } from './user-account-directory.service';
import { pickUserAccount } from './user-account-picker';

/** 镜像规则（备份群）缓存 TTL：中继是低频操作，但也不该每次转发都打库 */
const MIRROR_TARGET_CACHE_TTL_MS = 60_000;

export type { UserRelayFailureReason };

export interface UserRelayRequest {
  /** 源消息所在 chat（主存储群 / 归档群；**必须是用户账号可读的群或频道**） */
  sourceChatId: string;
  /** 源消息 ID */
  sourceMessageId: string;
  /** 中继目标群（各 bot 均为管理员/关闭隐私模式的副本可见群） */
  targetChatId: string;
  /** 优先使用的用户账号（镜像规则指定）；不可用时按权重确定性回落 */
  preferredAccountId?: string | null;
  /**
   * 幂等键：**同一逻辑操作的所有重试必须传相同值**。
   * 它同时决定选号种子与 MTProto `random_id`，从而保证「重试不产生重复消息」。
   * 缺省时退化为 `sourceChatId:sourceMessageId`（同一源消息天然幂等）。
   */
  idempotencyKey?: string;
}

export interface UserRelayResult {
  ok: boolean;
  /** 中继后群里的新消息 ID（可用于把该消息与逻辑文件关联） */
  messageId?: string;
  /** 实际执行中继的用户账号（`telegram_accounts.id`，不含任何凭据） */
  accountId?: string;
  reason?: UserRelayFailureReason;
  /** 已脱敏的可诊断摘要（用于日志与任务摘要，绝不含 session/apiHash） */
  detail?: string;
}

/**
 * `TelegramUserFailureKind` → 中继失败分类（**策略 B 的唯一错误口径**）。
 *
 * 为什么必须显式映射而不是透传 kind：后台 Top N 分布、告警阈值与重试策略都按
 * 这里的分类聚合；`unverified` 这类语义特殊的 kind 也必须落进「可重试」而不是
 * 被误当成普通未知错误——中继请求携带确定性 `random_id`，重试由服务端去重，
 * 因此「副作用可能已发生」重试是安全的，反而是不重试才会留下永久缺口。
 */
const RELAY_REASON_BY_KIND: Record<TelegramUserFailureKind, UserRelayFailureReason> = {
  unavailable: 'client_unavailable',
  auth: 'auth_invalid',
  permission: 'permission_denied',
  not_found: 'source_missing',
  flood: 'rate_limited',
  network: 'network',
  unsupported: 'unknown',
  unverified: 'unknown',
  other: 'unknown',
};

/**
 * 用户账号中继（策略 B：一次转发 → 各 bot 由入站链路自行登记副本）。
 *
 * **这是副本扩散的唯一执行方式**：策略 A（从源 Bot 下载后再向目标 Bot 上传）已整体移除，
 * 中继不可用时一律 fail-closed（明确失败状态 + 可诊断原因 + 退避重试），
 * 绝不发生文件字节的二次传输。
 *
 * **为什么必须有这一层而不是直接用 bot 转发**：Telegram 明确规定
 * 「bot 永远看不到其它 bot 发送的消息」（与隐私模式、管理员身份无关，本实验已实测）。
 * 因此「接收 bot 转发到群」**不能**让其它 bot 获得该文件；只有**用户账号**发出的消息
 * 才能被群里所有 bot（管理员/关闭隐私模式）看到，从而各自拿到自己的 `file_id`。
 *
 * 事实边界（不可含糊）：
 * - 中继是**服务端转发**（`messages.forwardMessages`），不重新下载/上传字节，
 *   但仍必须持有源 `chat_id + message_id`，且用户账号对源群可读、对目标群可写；
 * - 用户账号**读不到 bot 与其它用户的私聊**：`grant` 类来源（Bot 私聊入站文件）
 *   必须先由接收 Bot 用 Bot API 服务端复制到用户账号可读的群，见
 *   `telegram-mirror-source.service.ts#TelegramMirrorSourceService`。
 *
 * 幂等：选号种子与 `random_id` 都由幂等键派生，同一逻辑操作每次重试落到**同一账号**，
 * 因此服务端能据 `random_id` 去重，不会在副本可见群留下重复消息。
 */
@Injectable()
export class UserRelayService {
  private readonly logger = new Logger(UserRelayService.name);
  private readonly enabled: boolean;
  /** 启用中镜像规则的备份群缓存（见 resolveTargetChatId） */
  private cachedRuleTarget = '';
  private cachedRuleAtMs = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly userClient: TelegramUserClientService,
    private readonly directory: UserAccountDirectoryService,
    private readonly pool: TelegramAccountPoolService,
    /**
     * 镜像规则仓库：**中继目标群的唯一权威来源**。
     *
     * 用 `@Optional()`：大量单测直接 new 本服务；缺失时 `resolveTargetChatId()` 返回空串，
     * 由调用方按 `target_missing`（`blocked_target_chat`）收口，不再回退归档群。
     */
    @Optional() @InjectRepository(TelegramMirrorRule)
    private readonly rules: Repository<TelegramMirrorRule> | null = null,
  ) {
    this.enabled = (this.configService.get<string>('TELEGRAM_USER_RELAY_ENABLED') || '')
      .trim()
      .toLowerCase() === 'true';
    // 启动期高可见度信号：开关已开但客户端不可用属于「配置了却完全不可用」，
    // 只靠运行期 warn 会被淹没；这里显式报错让运维在启动日志里就能发现。
    // 注意：策略 A 已移除，此处**不存在**任何降级路径，扩散会明确失败并等待修复。
    if (this.enabled && !this.userClient.isAvailable()) {
      this.logger.error(
        `TELEGRAM_USER_RELAY_ENABLED=true 但 MTProto 客户端不可用（${this.userClient.unavailableReason() ?? '未知原因'}）：`
        + '副本扩散将保持阻塞（blocked_user_client），不会发生任何字节二次传输。',
      );
    }
  }

  /**
   * 是否具备用户账号中继能力。
   *
   * 判据只有两个同步可得的事实：开关已开 + MTProto 客户端可加载。
   * **刻意不把「已有可用用户账号」纳入**：账号列表是异步查库的，冷缓存时返回 false 会让
   * 首次中继被静默跳过。真实账号可用性由 `relay()` 判定并给出 `no_account`
   * ——宁可给出可诊断失败，也不要「看起来已配置但永远不走中继」。
   */
  isConfigured(): boolean {
    return this.enabled && this.userClient.isAvailable();
  }

  /**
   * 解析中继目标群（副本可见群）。
   *
   * **唯一权威来源：启用中的镜像规则 `targetChatId`**（规则启用前必须通过真实权限探测）。
   * 刻意**不再回退** `TELEGRAM_ARCHIVE_CHAT_ID` / `TELEGRAM_CHAT_ID`：归档群只是审计转发
   * 目的地，它的成员与权限没有经过「全部 Bot 可见」的校验，用它做副本可见群会让中继
   * 「转发成功但无人认领」——表现为副本数长期为 0，而日志里全是成功记录。
   * 未配置启用规则时返回空串，由调用方按 `target_missing` 收口为 `blocked_target_chat`。
   */
  async resolveTargetChatId(): Promise<string> {
    if (!this.rules) return '';
    try {
      if (!this.cachedRuleFresh()) {
        const rule = await this.rules.findOne({ where: { enabled: true } });
        this.cachedRuleTarget = (rule?.targetChatId || '').trim();
        this.cachedRuleAtMs = Date.now();
      }
      return this.cachedRuleTarget;
    } catch (error) {
      this.logger.warn(
        `镜像备份群读取失败（本轮按目标群缺失处理，不再回退归档群）：`
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return '';
    }
  }

  private cachedRuleFresh(): boolean {
    return this.cachedRuleAtMs > 0 && Date.now() - this.cachedRuleAtMs < MIRROR_TARGET_CACHE_TTL_MS;
  }

  /** 是否已开启中继开关（用于报告与排障，不代表可用） */
  isEnabledByConfig(): boolean {
    return this.enabled;
  }

  /**
   * 用用户账号把源消息服务端转发到副本可见群。
   *
   * 失败一律返回 `{ok:false, reason}` 而**不抛出**：调用方据此收口为 `blocked_*` /
   * `retryable_failed` 轮次记录（策略 B 的 fail-closed 语义），中继不可用时文件仍然可用
   * （已有副本照常下载），只是**不会**再有新的副本产生。
   */
  async relay(request: UserRelayRequest): Promise<UserRelayResult> {
    // 「未开启开关」是明确的产品状态而非执行失败：不计数（否则关闭中继的部署会一直报故障）
    if (!this.enabled) {
      return { ok: false, reason: 'not_configured', detail: 'TELEGRAM_USER_RELAY_ENABLED 未开启' };
    }
    this.pool.bumpCounter('relayAttempts');

    if (!this.userClient.isAvailable()) {
      return this.fail('client_unavailable', this.userClient.unavailableReason() ?? 'MTProto 客户端不可用');
    }

    const sourceChatId = (request.sourceChatId || '').trim();
    const sourceMessageId = (request.sourceMessageId || '').trim();
    const targetChatId = (request.targetChatId || '').trim();
    if (!sourceChatId || !sourceMessageId) {
      return this.fail('source_missing', '缺少源消息定位（chat_id + message_id）');
    }
    if (!targetChatId) {
      return this.fail('target_missing', '没有启用中的镜像规则目标群（副本可见群）');
    }

    const accounts = await this.directory.listEnabled();
    if (accounts.length === 0) {
      return this.fail('no_account', '没有可用（已授权且启用）的 Telegram 用户账号');
    }

    // 幂等种子**必须包含目标群**：同一源消息中继到不同群是**不同操作**，
    // 共用同一个 random_id 会让服务端按去重返回旧消息 ID，把目标位置报错。
    // 因此即便调用方显式给了幂等键，也要把目标群拼进去。
    const explicitKey = (request.idempotencyKey || '').trim();
    const seed = explicitKey
      ? `${explicitKey}:${targetChatId}`
      : `${sourceChatId}:${sourceMessageId}:${targetChatId}`;
    const picked = pickUserAccount(accounts, request.preferredAccountId, seed);
    if (picked.fallbackFromPreferred) {
      this.logger.warn(`规则指定的优先用户账号 ${request.preferredAccountId} 不可用，已按权重确定性回落`);
    }
    const chosen = picked.account;

    try {
      const copied = await this.userClient.copyMessage({
        credentials: { apiId: chosen.apiId, apiHash: chosen.apiHash, session: chosen.session },
        sourceChatId,
        sourceMessageId,
        targetChatId,
        // 幂等键 = 逻辑操作 + 执行账号：选号确定性保证了同一操作每次重试都是这个值
        idempotencyKey: `${seed}:${chosen.id}`,
      });
      this.pool.bumpCounter('relaySucceeded');
      this.logger.log(
        `用户账号中继成功：账号 ${this.maskAccountId(chosen.id)} / 源 ${this.mask(sourceChatId)}`
        + `→目标 ${this.mask(targetChatId)} / 新消息 ${this.maskAccountId(copied.targetMessageId)}`,
      );
      return { ok: true, messageId: copied.targetMessageId, accountId: chosen.id };
    } catch (error) {
      const isClientError = error instanceof TelegramUserClientError;
      const kind: TelegramUserFailureKind = isClientError ? error.kind : 'other';
      const reason = RELAY_REASON_BY_KIND[kind] ?? 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      // 凭据失效必须让管理员可见：否则账号一直显示 active，中继却持续失败，运维无从下手
      if (kind === 'auth') {
        await this.directory.markDegraded(chosen.id, 'user_session_invalid', message);
      }
      this.logger.warn(`用户账号中继失败（账号 ${chosen.id} / ${reason}）：${message.slice(0, 200)}`);
      // 返回值会进入轮次记录/审计等展示面，因此只回传**已脱敏**的分类摘要：
      // `TelegramUserClientError` 的消息在客户端内已做脱敏（长 hex 替换、截断），
      // 其它未知异常一律不回传原文（避免把 session/apiHash 带出内存）。
      return this.fail(
        reason,
        isClientError ? `${kind}: ${message.slice(0, 200)}` : '用户账号中继执行失败（详见后端日志）',
      );
    }
  }

  /** 失败收口：统一计数（`not_configured` 之外全部计入 `relayFailed`）并返回脱敏结果 */
  private fail(reason: UserRelayFailureReason, detail: string): UserRelayResult {
    this.pool.bumpCounter('relayFailed');
    return { ok: false, reason, detail };
  }

  /** chat id 脱敏（只保留末 4 位，避免把完整群标识写进日志） */
  private mask(chatId: string): string {
    const trimmed = chatId.trim();
    if (trimmed.length <= 4) return '***';
    return `***${trimmed.slice(-4)}`;
  }

  /** 内部标识脱敏（账号 / 消息 id 只保留前 4 位，日志里不做定位依据） */
  private maskAccountId(value: string | null | undefined): string {
    const trimmed = (value || '').trim();
    if (!trimmed) return '***';
    return trimmed.length <= 4 ? '***' : `${trimmed.slice(0, 4)}…`;
  }
}
