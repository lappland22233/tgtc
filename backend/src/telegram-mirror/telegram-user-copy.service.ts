import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TelegramMirrorRule } from '../common/entities/telegram-mirror-rule.entity';
import { TelegramMirrorTask } from '../common/entities/telegram-mirror-task.entity';
import type { TelegramReplicationAttempt } from '../common/entities/telegram-replication-attempt.entity';
import type { UserRelayFailureReason } from '../common/entities/telegram-replication-attempt.entity';
import { pickUserAccount } from '../telegram-account-pool/user-account-picker';
import { FileCopyService } from '../telegram-account-pool/file-copy.service';
import { ReplicaTargetResolver } from '../telegram-account-pool/replica-target.resolver';
import { TelegramAccountPoolService } from '../telegram-account-pool/telegram-account-pool.service';
import {
  attemptStatusForRelayFailure,
  ReplicationAttemptService,
} from '../telegram-account-pool/replication-attempt.service';
import { TelegramAccountsService } from '../telegram-accounts/telegram-accounts.service';
import { maskIdentifier } from '../telegram-accounts/telegram-account-view';
import { TelegramUserClientService } from '../telegram-user/telegram-user-client.service';
import { TelegramMirrorSourceService } from './telegram-mirror-source.service';
import { TelegramMainChatAnchorService } from './telegram-main-chat-anchor.service';
import {
  MirrorExecutionError,
  classifyMirrorError,
  isAccountCredentialError,
} from './telegram-mirror.errors';
import { MirrorExecutionResult } from './telegram-mirror.types';

/**
 * 认领窗口：中继成功后等待「镜像群内各 Bot 各自登记副本」的时间。
 *
 * 只影响**观测轮次的结算时点**，不占用任何队列并发：窗口到期由后台清扫服务结算
 * （`waiting_claims` → succeeded / partial_success / claim_timeout）。
 * 之所以不在 job 里阻塞等待：镜像队列并发仅 2，而提交即触发会让队列量级变为
 * 「收到的每个文件 × 每条启用规则」，阻塞等待会把队列拖垮。
 */
const CLAIM_WINDOW_MS = 12_000;

/**
 * 副本扩散的**唯一执行器**：用户账号(userbot) 从主群服务端转发到镜像群。
 *
 * 链路（不可分割的一步）：
 * 1. 「持有源消息的 Bot 账号」把源消息服务端转发进**主群**（`TelegramMainChatAnchorService`，
 *    幂等、零字节、锚点持久化）；
 * 2. 用户账号从**主群**用 MTProto 服务端转发到 `rule.targetChatId`（本类）。
 *
 * 事实边界（不可含糊）：
 * - 全程**不重新下载/上传文件字节**（服务端 `forwardMessages`），字节二次传输恒为 0；
 * - 用户账号必须同时是**主群**与镜像群的成员：主群可读、镜像群可写，否则明确失败；
 * - 权限不足、源消息不可访问、session 失效时**必须明确失败**，绝不允许报告成功，
 *   也绝不降级为「Bot 重新上传」；
 * - 该路径产生的目标消息没有「Bot 可用的 file_id」，因此**不写入副本表**，
 *   只以 `targetMessageId` 作为定位锚点（备份可用性由群内消息保证）。
 *
 * 副本认领（本路径的完成条件，见 bot 入站链路）：镜像群里的消息由**用户账号**发出，
 * 因此群内每个 Bot（管理员/关闭隐私模式）都会各自收到更新，登记**自己账号的**
 * `file_id` 副本；这些副本再经「入站副本 → 站内文件」桥接后即可参与下载负载均衡。
 */
@Injectable()
export class TelegramUserCopyService {
  private readonly logger = new Logger(TelegramUserCopyService.name);

  constructor(
    private readonly source: TelegramMirrorSourceService,
    private readonly anchors: TelegramMainChatAnchorService,
    private readonly accounts: TelegramAccountsService,
    private readonly userClient: TelegramUserClientService,
    // 以下为**可选**的观测依赖：缺任何一个都只影响「扩散轮次」时间线，
    // 绝不影响扩散本身（fail-closed 的是扩散能力，不是观测能力）。
    @Optional() @Inject(ReplicationAttemptService)
    private readonly attempts: ReplicationAttemptService | null = null,
    @Optional() @Inject(FileCopyService)
    private readonly copies: FileCopyService | null = null,
    @Optional() @Inject(ReplicaTargetResolver)
    private readonly replicaTargets: ReplicaTargetResolver | null = null,
    // 账号池计数（中继健康度三元组 relayAttempts/relaySucceeded/relayFailed 的唯一写入方）
    @Optional() @Inject(TelegramAccountPoolService)
    private readonly pool: TelegramAccountPoolService | null = null,
  ) {}

  async execute(task: TelegramMirrorTask, rule: TelegramMirrorRule): Promise<MirrorExecutionResult> {
    if (!this.userClient.isAvailable()) {
      throw new MirrorExecutionError(
        'user_client_unavailable',
        `MTProto 客户端不可用（${this.userClient.unavailableReason() ?? '依赖未安装'}）`,
        'blocked',
      );
    }

    const targetChatId = (rule.targetChatId || '').trim();
    if (!targetChatId) {
      throw new MirrorExecutionError('target_chat_missing', '镜像规则未配置镜像群（目标群）', 'blocked');
    }

    // 观测轮次：先开轮次再中继，`baselineReadyCount` 才能反映**中继前**的副本数，
    // 否则本轮自己带来的认领会被算成「历史既有」，结算永远看不到新增。
    const round = await this.openRound(task, targetChatId);

    // 源事实 + 主群锚点：**任何**前置失败都必须收口轮次。
    // 否则轮次会永久停在 active 态（清扫只结算 `waiting_claims`），
    // 后台时间线长期显示「进行中」，后续 beginRound 还会误判为可合并。
    let descriptor: Awaited<ReturnType<TelegramMirrorSourceService['describe']>>;
    let anchor: { chatId: string; messageId: string };
    try {
      descriptor = await this.source.describe(task.ownerType, task.ownerId);
      // 主群锚点：私聊、账号存储群、镜像群等**任何来源**都先落主群，
      // 用户账号只从主群中继——这是「单一源锚点」语义的全部意义。
      anchor = await this.anchors.ensureAnchor({
        ownerType: task.ownerType,
        ownerId: task.ownerId,
        sourceChatId: descriptor.chatId,
        sourceMessageId: descriptor.messageId,
        // 归属优先用任务行固化的事实（任务创建时写入），缺失时回落到描述
        sourceAccountId: task.sourceAccountId ?? descriptor.sourceAccountId,
        // 源内容版本（仅日志/诊断用）：主群锚点据此识别「同一 file.id 覆盖上传」并重搬，
        // 避免新版本任务从旧版本的主群消息中继（镜像群停在旧内容）
        sourceVersion: task.sourceVersion,
      });
    } catch (error) {
      await this.closeRoundFailed(round, error);
      throw error;
    }

    let candidates: Awaited<ReturnType<TelegramAccountsService['resolveEnabledUserAccounts']>>;
    try {
      candidates = await this.accounts.resolveEnabledUserAccounts();
    } catch (error) {
      await this.closeRoundFailed(round, error);
      throw error;
    }
    if (candidates.length === 0) {
      const error = new MirrorExecutionError(
        'no_user_account',
        '没有可用（已授权且启用）的 Telegram 用户账号，无法执行服务端转发',
        'blocked',
      );
      await this.closeRoundFailed(round, error);
      throw error;
    }
    const chosen = this.pickUser(candidates, rule.preferredAccountId, task.id);

    let copied: { targetChatId: string; targetMessageId: string };
    try {
      copied = await this.userClient.copyMessage({
        credentials: { apiId: chosen.apiId, apiHash: chosen.apiHash, session: chosen.session },
        sourceChatId: anchor.chatId,
        sourceMessageId: anchor.messageId,
        targetChatId,
        // 幂等键 = 任务 + 镜像群 + 执行账号。
        //
        // 「镜像群」必须在键内：多镜像群各自一条任务，若只用任务 + 账号，同一个
        // random_id 会被服务端按去重返回**另一个镜像群**的消息 ID，而结果里的
        // targetChatId 是本群——定位与实际位置不一致。
        // 「账号」也必须在键内：账号选择是确定性的（见 pickUser），因此同一任务的所有
        // 重试都会派生出同一个 random_id，服务端据此去重，不会在镜像群留下重复副本。
        idempotencyKey: `${task.id}:${targetChatId}:${chosen.id}`,
      });
    } catch (error) {
      // 顺序不可交换：先按**原始错误**收口轮次（否则轮次会停在 active，清扫只结算
      // `waiting_claims`，后台时间线会长期显示「进行中」），再标记账号降级。
      // 降级标记是附带副作用，其自身失败（如库故障）绝不能顶掉原始错误分类、
      // 更不能把轮次失败收口一起跳过。
      await this.closeRoundFailed(round, error);
      if (isAccountCredentialError(error)) {
        try {
          await this.accounts.markDegraded(
            chosen.id,
            'user_session_invalid',
            error instanceof Error ? error.message : String(error),
          );
        } catch (degradeError) {
          this.logger.warn(
            `用户账号降级标记失败（仅影响后台展示，扩散结论不受影响）：`
            + `${degradeError instanceof Error ? degradeError.message : String(degradeError)}`,
          );
        }
      }
      throw error;
    }

    // 转发成功只是中间态：开立认领等待窗口，由后台清扫按窗口结算
    await this.markRoundRelayingDone(round, chosen.id, copied.targetMessageId);

    this.logger.log(
      `镜像完成（主群 → userbot 服务端转发）：${task.ownerType}:${task.ownerId} → `
      + `账号 ${maskIdentifier(chosen.id)} / 镜像群 ${maskIdentifier(copied.targetChatId)} / `
      + `消息 ${maskIdentifier(copied.targetMessageId)}`,
    );
    return {
      targetAccountId: chosen.id,
      targetChatId: copied.targetChatId,
      targetMessageId: copied.targetMessageId,
      // 用户转发的目标消息没有 Bot API file_id（不登记副本表，避免跨体系误用）；
      // 各 Bot 会在收到群内该消息后登记**各自**的副本。
      targetTelegramFileId: '',
      fileSize: descriptor.fileSize,
      mode: 'user_copy',
    };
  }

  // ---------------- 扩散轮次（认领观测层） ----------------

  /**
   * 开立/复用一条扩散轮次（best-effort）。
   *
   * 观测不可用（依赖未装配、库写入失败）时返回 `null` 并记日志：**扩散本身继续执行**，
   * 绝不因为「后台看不到时间线」而阻断真实的文件扩散。
   */
  private async openRound(
    task: TelegramMirrorTask,
    targetChatId: string,
  ): Promise<TelegramReplicationAttempt | null> {
    if (!this.attempts) return null;
    this.pool?.bumpCounter('relayAttempts');
    try {
      const ready = this.copies ? await this.copies.readyAccountIds(task.ownerType, task.ownerId) : [];
      const desiredCount = Math.max(1, (await this.replicaTargets?.desiredReplicas()) ?? 1);
      const begin = await this.attempts.beginRound({
        ownerType: task.ownerType,
        ownerId: task.ownerId,
        sourceAccountId: task.sourceAccountId ?? null,
        targetChatId,
        idempotencyKey: `mirror:${task.id}:${targetChatId}`,
        desiredCount,
        baselineReadyCount: ready.length,
        triggeredBy: 'eager',
      });
      return begin.attempt;
    } catch (error) {
      this.logger.warn(
        `扩散轮次开立失败（仅影响观测，扩散继续）：${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** 中继成功：进入认领等待窗口（异步结算，不阻塞队列） */
  private async markRoundRelayingDone(
    round: TelegramReplicationAttempt | null,
    relayAccountId: string,
    relayMessageId: string,
  ): Promise<void> {
    if (!round || !this.attempts) return;
    try {
      await this.attempts.markRelaySucceeded(round.id, {
        relayAccountId,
        relayMessageId,
        claimDeadlineAt: new Date(Date.now() + CLAIM_WINDOW_MS),
      });
      // 「认领成功率」分母：中继实际完成（转发成功）的轮次
      this.pool?.bumpCounter('relaySucceeded');
    } catch (error) {
      this.logger.warn(
        `扩散轮次结算失败（转发已成功，仅影响观测）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 中继失败/前置阻塞：按统一映射表收口轮次状态（与后台展示、告警口径同源） */
  private async closeRoundFailed(round: TelegramReplicationAttempt | null, error: unknown): Promise<void> {
    if (!round || !this.attempts) return;
    try {
      const classification = classifyMirrorError(error);
      const reason = this.relayFailureReason(classification.code);
      this.pool?.bumpCounter('relayFailed');
      await this.attempts.finishBlocked(round.id, {
        status: attemptStatusForRelayFailure(reason),
        failureReason: reason,
        failureSummary: classification.summary,
      });
    } catch (finishError) {
      this.logger.warn(
        `扩散轮次失败收口失败（仅影响观测）：`
        + `${finishError instanceof Error ? finishError.message : String(finishError)}`,
      );
    }
  }

  /**
   * 镜像错误码 → 轮次失败原因（`UserRelayFailureReason`）。
   *
   * 这张映射是「后台展示 / 告警口径 / 是否可重试」的一致性来源，
   * 集中在此而不是散落到调用方。
   */
  private relayFailureReason(code: string): UserRelayFailureReason {
    switch (code) {
      case 'user_client_unavailable':
        return 'client_unavailable';
      case 'no_user_account':
        return 'no_account';
      case 'target_chat_missing':
      case 'target_chat_not_configured':
        return 'target_missing';
      // 主群相关的全部失败都归为「源锚点不可用」：用户账号的中继源**就是**主群锚点
      case 'source_message_unresolved':
      case 'source_message_missing':
      // 处理器在站内文件行不存在时给出的错误码（文件被删除/被覆盖清理）
      case 'source_file_missing':
      case 'source_file_unavailable':
      case 'main_chat_missing':
      case 'main_chat_conflict':
      case 'main_chat_invalid':
      case 'main_chat_bot_unresolved':
      case 'main_chat_client_unavailable':
      case 'main_chat_anchor_unavailable':
      case 'main_chat_anchor_persist_failed':
        return 'source_missing';
      case 'target_permission_denied':
      case 'permission_denied':
      case 'user_permission_denied':
        return 'permission_denied';
      case 'account_unauthorized':
      case 'user_session_invalid':
        return 'auth_invalid';
      case 'flood_wait':
        return 'rate_limited';
      case 'network_error':
      case 'user_client_network':
      case 'account_timeout':
      case 'account_network':
        return 'network';
      default:
        // 未识别错误一律可重试（由最大尝试次数兜底）。
        // 其中 `main_chat_anchor_pending`（主群锚点在租约内搬运中）刻意走这里：
        // 它必须落在 `retryable_failed`，等租约到期后重试自动接管重搬。
        return 'unknown';
    }
  }

  // ---------------- 选号 ----------------

  /**
   * 优先规则指定账号；否则按权重展平后用**稳定种子**选择（同权重账号均匀分流）。
   *
   * 实现委托给无依赖纯函数 `pickUserAccount`，与账号池的用户账号中继（策略 B）
   * **共用同一份选号语义**，避免两处实现漂移出「一个用种子、一个用游标」的不一致。
   */
  private pickUser<T extends { id: string; weight: number }>(
    candidates: T[],
    preferredAccountId: string | null | undefined,
    seed: string,
  ): T {
    const picked = pickUserAccount(candidates, preferredAccountId, seed);
    if (picked.fallbackFromPreferred) {
      this.logger.warn(`规则指定的优先用户账号 ${preferredAccountId} 不可用，改为按权重选择`);
    }
    return picked.account;
  }
}
