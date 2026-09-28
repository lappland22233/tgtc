import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { TelegramMainChatAnchor } from '../common/entities/telegram-main-chat-anchor.entity';
import { TelegramCopyOwnerType } from '../common/entities/telegram-file-copy.entity';
import { TelegramAccountClientService } from '../telegram-account-pool/telegram-account-client.service';
import { TelegramAccountPoolService } from '../telegram-account-pool/telegram-account-pool.service';
import { TelegramAccountsService } from '../telegram-accounts/telegram-accounts.service';
import { maskIdentifier } from '../telegram-accounts/telegram-account-view';
import { TelegramMirrorConfigService } from './telegram-mirror-config.service';
import { MirrorExecutionError } from './telegram-mirror.errors';

/**
 * 搬运预留的租约时长。
 *
 * 预留行（`status='pending'`）超过该时长即视为「上一次搬运在落库前中断」的残留，
 * 允许后续调用接管重搬——否则一次进程崩溃会让该文件的扩散永久停在 pending 上。
 * 代价是极端情况下主群可能多出一条重复消息（由 warn 日志与 `mainChatPlantTakeovers`
 * 计数暴露，需人工核对）。
 *
 * **必须小于任务重试预算**（`MIRROR_MAX_ATTEMPTS` 次尝试的退避之和，见
 * `telegram-main-chat-anchor.service.spec.ts` 中的关系断言）：租约内的重复触发只会
 * 得到 `main_chat_anchor_pending/retryable`，任务必须**还能再重试一次**才能等到租约
 * 到期自动接管；若把租约调到超过重试预算，任务会在租约内耗尽重试并永久 failed，
 * 锚点则长期停在 pending 上，只能靠人工/再次触发恢复。
 */
export const PLANT_RESERVATION_LEASE_MS = 5 * 60_000;

/**
 * 「预留仍在租约内」时给出的重试延迟余量（叠加在租约剩余时间之上）。
 *
 * 目的是让重试**确定性地落在租约到期之后**（同一实例内本机时钟，15 秒余量足够吸收
 * 时间戳写入/读取的精度差），从而保证「最后一次可重试的尝试」也能成功接管。
 */
const PLANT_RETRY_AFTER_MARGIN_MS = 15_000;

/** 唯一键冲突判定（覆盖 PG / SQLite 两种方言的消息文本） */
function isUniqueViolation(message: string): boolean {
  return /UNIQUE|duplicate key|SQLITE_CONSTRAINT/i.test(message);
}

/** 确保主群锚点的输入（源锚点事实由 `TelegramMirrorSourceService.describe()` 提供） */
export interface EnsureMainChatAnchorInput {
  ownerType: TelegramCopyOwnerType;
  ownerId: string;
  /** 源消息所在 chat（私聊=正数用户 ID；账号存储群/镜像群=负数） */
  sourceChatId?: string | null;
  sourceMessageId?: string | null;
  /** **持有该消息**的 Bot 账号（搬运只允许由它执行，绝不跨账号代搬） */
  sourceAccountId?: string | null;
  /**
   * 源内容版本（`file` = uploadVersion；`grant`/`fileUnique` 恒为 1）。
   * 仅用于日志与诊断，不落库（表无该列，避免迁移）。
   */
  sourceVersion?: number;
}

/** 主群锚点（MTProto 中继的源定位） */
export interface MainChatAnchor {
  chatId: string;
  messageId: string;
  /** 本次调用是否真的执行了搬运（false = 复用既有锚点，或源消息本就在主群） */
  planted: boolean;
}

/**
 * 主群锚点服务（副本扩散的唯一中转落点）。
 *
 * ## 链路中的位置
 *
 * 「主 BOT 收到文件 → 转发到主群 → userbot 从主群转发到各镜像群」——
 * 本服务负责第一步的**落点保证**：把「持有源消息的 Bot 账号」手里的那条消息
 * 用 Bot API 服务端转发（`forwardMessage`，零字节重传）进主群，并把
 * `(主群 chatId, 主群 messageId)` 持久化，供用户账号按 `chat_id + message_id` 中继。
 *
 * ## 为什么必须持久化 + 单飞
 *
 * - Bot API 的 `forwardMessage` **没有幂等键**：重试会再搬一次并在主群留下重复消息；
 * - 一个文件会对 N 条启用规则各建一条任务，**锚点必须在任务之间共享**（一个文件一行），
 *   否则同一文件会被搬运 N 次。
 *
 * 因此：**先落库再执行** —— 未命中时先写入一行 `status='pending'` 的预留（唯一键
 * `(ownerType, ownerId)` 冲突即说明「他人正在搬运或已搬运」，绝不重复搬运），
 * 预留成功后由「持有源消息的 Bot 账号」执行**一次**服务端转发，再把结果写回 `ready`；
 * 进程内单飞（单后端实例是产品硬约束）再挡一层同实例并发。
 * 接管（超租约的 `pending`、`failed`、或指向旧主群的 `ready`）用「删旧行 + 重新插入」
 * 的**唯一键 CAS** 完成，保证同一时刻只有一个执行者持有预留。
 * 搬运失败写 `status='failed'` + `lastError` 供运维定位（失败无副作用残留，可直接接管重搬），
 * 并把原始错误抛给上游做分类（blocked / retryable）。
 *
 * ## 边界（不可含糊）
 *
 * - 用户账号读不到 Bot 与用户的私聊，也未必是各账号存储 Chat 的成员：
 *   所以**任何来源都要先落到主群**，不允许「源锚点恰好可读就跳过搬运」的隐式捷径；
 * - 源消息已在主群时不再搬运（避免主群里出现同一条消息的转发副本）；
 * - 主群必须是群/频道（chat id 为负数）：私聊无法承载「一个落点、多个读取者」的语义；
 * - 主群由启用中的镜像规则 `sourceChatId` 解析而来，**所有启用规则必须一致**，
 *   否则明确失败（见 `TelegramMirrorConfigService.resolveMainChatId`）。
 */
@Injectable()
export class TelegramMainChatAnchorService {
  private readonly logger = new Logger(TelegramMainChatAnchorService.name);
  /** 进程内单飞：同一归属对象的并发任务只搬运一次（单后端实例语义） */
  private readonly inflight = new Map<string, Promise<MainChatAnchor>>();

  constructor(
    @InjectRepository(TelegramMainChatAnchor)
    private readonly repo: Repository<TelegramMainChatAnchor>,
    private readonly config: TelegramMirrorConfigService,
    // 以下为可选依赖：未装配时给出可诊断的 blocked 错误，而不是静默跳过搬运。
    // 必须显式 `@Inject(X)`：`X | null` 联合类型发出的是 `Object`，
    // 否则 `@Optional()` 会把解析失败静默降级成 `null`（搬运能力整体缺失）。
    @Optional() @Inject(TelegramAccountClientService)
    private readonly client: TelegramAccountClientService | null = null,
    @Optional() @Inject(TelegramAccountPoolService)
    private readonly pool: TelegramAccountPoolService | null = null,
    @Optional() @Inject(TelegramAccountsService)
    private readonly accounts: TelegramAccountsService | null = null,
    @Optional() @Inject(ConfigService)
    private readonly configService: ConfigService | null = null,
  ) {}

  /** 当前主群 chat id（未配置/冲突/私聊时抛 blocked 错误，供能力预检复用） */
  async resolveMainChatIdOrThrow(): Promise<string> {
    const resolution = await this.config.resolveMainChatId();
    if (!resolution.ok) {
      throw new MirrorExecutionError(resolution.code, resolution.summary, 'blocked');
    }
    const chatId = resolution.chatId.trim();
    if (this.isPrivateChat(chatId)) {
      throw new MirrorExecutionError(
        'main_chat_invalid',
        `主群必须是群或频道（chat id 为负数），当前配置为私聊 ${chatId}：`
        + '请把镜像规则的源群改为承载中转落点的群',
        'blocked',
      );
    }
    return chatId;
  }

  /**
   * 确保主群锚点存在（必要时搬运），返回可供 MTProto 中继使用的源定位。
   *
   * 幂等：同一 `(ownerType, ownerId)` 的重复调用只会搬运一次（锚点表 + 进程内单飞双保险）。
   */
  async ensureAnchor(input: EnsureMainChatAnchorInput): Promise<MainChatAnchor> {
    const mainChatId = await this.resolveMainChatIdOrThrow();
    const sourceChatId = String(input.sourceChatId ?? '').trim();
    const sourceMessageId = String(input.sourceMessageId ?? '').trim();
    if (!sourceChatId || !sourceMessageId) {
      throw new MirrorExecutionError(
        'source_message_unresolved',
        '缺少源消息定位（chat_id + message_id），无法搬运到主群；'
        + '请确认文件的副本锚点已登记（Bot 入站/后台上传成功后会写入）',
        'blocked',
      );
    }

    const cached = await this.findReusable(input, mainChatId);
    if (cached) return cached;

    // 源消息就在主群：无需搬运（这是 Web 上传直接落在主存储群的情形），
    // 只登记锚点。此处即使落库失败也**不阻塞**：没有任何转发副作用，
    // 不存在「重试重复搬运」的风险，中继本身由 random_id 保证幂等。
    if (sourceChatId === mainChatId) {
      const anchor: MainChatAnchor = { chatId: mainChatId, messageId: sourceMessageId, planted: false };
      await this.persistReady(input, anchor, null);
      return anchor;
    }

    const key = `${input.ownerType}:${input.ownerId}`;
    const running = this.inflight.get(key);
    if (running) return running;

    const task = this.plantToMainChat(input, mainChatId, sourceChatId, sourceMessageId)
      .finally(() => {
        // 只清理自己的任务：无条件 delete 会把后来者的在途任务摘掉，单飞随之失效。
        if (this.inflight.get(key) === task) this.inflight.delete(key);
      });
    this.inflight.set(key, task);
    return task;
  }

  /** 已落库且仍指向当前主群的可用锚点（避免重复搬运产生主群重复消息） */
  private async findReusable(
    input: EnsureMainChatAnchorInput,
    mainChatId: string,
  ): Promise<MainChatAnchor | null> {
    const row = await this.readRow(input.ownerType, input.ownerId);
    if (!row) return null;
    if (row.status !== 'ready') return null;
    if (String(row.anchorChatId ?? '').trim() !== mainChatId) return null;
    const messageId = String(row.anchorMessageId ?? '').trim();
    if (!messageId) return null;
    // 源内容指纹校验：`file` 覆盖上传后，旧锚点指向的是**旧内容**的主群消息，
    // 直接复用会让新版本任务从旧消息中继（镜像群拿到旧内容而任务记为成功）
    if (!this.isSourceFingerprintMatch(input, row)) return null;
    return { chatId: mainChatId, messageId, planted: false };
  }

  /**
   * 源内容指纹是否匹配（决定既有 `ready` 锚点能否复用）。
   *
   * 为什么必须存在：`file` 归属的锚点行以 `(ownerType, ownerId)` 为唯一键，
   * 覆盖上传（同一 `file.id` 换新内容）不会换 `ownerId`——没有指纹校验时，
   * 新版本任务会从**旧版本**的主群消息中继，镜像群拿到旧内容而任务记为成功。
   *
   * 判据与理由：
   * - 非 `file` 归属一律视为匹配：`grant` 授权记录不可变；`fileUnique` 的逻辑主键
   *   本身就是内容 `file_unique_id`，不同副本消息指向同一内容，沿用既有复用语义，
   *   避免因副本行顺序变化触发无意义重搬、在主群留下重复消息；
   * - 传入的 `sourceChatId`/`sourceMessageId` 任一为空 → 匹配：缺失信息不等于内容变更；
   * - 存量行的 `sourceChatId`/`sourceMessageId` 任一为空 → 匹配（历史锚点行即如此）；
   * - 否则要求 `sourceChatId` 与 `sourceMessageId` 都完全相等。
   */
  private isSourceFingerprintMatch(
    input: EnsureMainChatAnchorInput,
    row: Pick<TelegramMainChatAnchor, 'sourceChatId' | 'sourceMessageId'>,
  ): boolean {
    if (input.ownerType !== 'file') return true;
    const nextChatId = String(input.sourceChatId ?? '').trim();
    const nextMessageId = String(input.sourceMessageId ?? '').trim();
    if (!nextChatId || !nextMessageId) return true;
    const rowChatId = String(row.sourceChatId ?? '').trim();
    const rowMessageId = String(row.sourceMessageId ?? '').trim();
    if (!rowChatId || !rowMessageId) return true;
    return rowChatId === nextChatId && rowMessageId === nextMessageId;
  }

  /**
   * 读取锚点行（不存在返回 `null`）。
   *
   * **读失败不能静默当成「没有锚点」**：那会导致重复搬运。因此库故障一律
   * 按 blocked 中止本轮扩散，让任务保留状态并由重试恢复。
   */
  private async readRow(
    ownerType: TelegramCopyOwnerType,
    ownerId: string,
  ): Promise<TelegramMainChatAnchor | null> {
    try {
      return await this.repo.findOne({ where: { ownerType, ownerId } });
    } catch (error) {
      throw new MirrorExecutionError(
        'main_chat_anchor_unavailable',
        `主群锚点读取失败，已中止本轮扩散以避免重复搬运：`
        + `${error instanceof Error ? error.message : String(error)}`.slice(0, 400),
        'blocked',
      );
    }
  }

  /**
   * 读取**必须存在**的锚点行（预留路径：唯一键冲突后回读）。
   * 缺失只可能是记录被并发清理/删除，按可重试收口（下一轮即可恢复）。
   */
  private async requireRow(
    ownerType: TelegramCopyOwnerType,
    ownerId: string,
  ): Promise<TelegramMainChatAnchor> {
    const row = await this.readRow(ownerType, ownerId);
    if (!row) {
      throw new MirrorExecutionError(
        'main_chat_anchor_unavailable',
        '主群锚点唯一键冲突后回读不到记录（可能被并发清理），本轮按可重试处理',
        'retryable',
      );
    }
    return row;
  }

  /**
   * 预留锚点行（`status='pending'`）——「先落库再执行」的落地点。
   *
   * 返回值语义：
   * - `null`：本调用已持有预留，可以执行搬运；
   * - 非 null：无需搬运（并发者/上一次调用已完成），直接复用该锚点。
   *
   * `(ownerType, ownerId)` 唯一键冲突即说明「该归属对象已有锚点行」，按行状态收口：
   * - `ready` 且仍指向当前主群且源内容指纹匹配 → 复用，不重复搬运；
   * - `failed`（上一次转发未成功，无副作用残留）→ 立即接管重搬；
   * - `pending` 且在租约内 → **可重试失败**（等租约到期自动接管，绝不冒险再搬一次）；
   * - `pending` 且超出租约 → 视为上次进程中断的残留，接管重搬并 warn（可能已在主群留下消息）；
   * - `ready` 但指向旧主群（主群配置变更）→ 接管重搬并 warn（旧主群那条消息作废）；
   * - `ready` 但源内容指纹不匹配（同一 `file.id` 覆盖上传）→ 接管重搬并 warn（按新内容）。
   */
  private async reserve(
    input: EnsureMainChatAnchorInput,
    mainChatId: string,
  ): Promise<MainChatAnchor | null> {
    const payload = {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      anchorChatId: mainChatId,
      anchorMessageId: null,
      plantedByAccountId: null,
      sourceChatId: String(input.sourceChatId ?? '').trim() || null,
      sourceMessageId: String(input.sourceMessageId ?? '').trim() || null,
      status: 'pending' as const,
      lastError: null,
      // pending 行里它是**预留时间**（租约起算点）；搬运成功后改写为完成时间
      plantedAt: new Date(),
    };
    try {
      await this.repo.insert(this.repo.create(payload));
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isUniqueViolation(message)) {
        // 没有预留就搬运 = 失去幂等保护（崩溃/重试会再搬一次），因此按 blocked 中止
        throw new MirrorExecutionError(
          'main_chat_anchor_unavailable',
          `主群锚点预留失败，已中止本轮扩散以避免重复搬运：${message}`.slice(0, 400),
          'blocked',
        );
      }
    }

    const row = await this.requireRow(input.ownerType, input.ownerId);
    const anchorChatId = String(row.anchorChatId ?? '').trim();
    const anchorMessageId = String(row.anchorMessageId ?? '').trim();
    // 复用判据与 `findReusable` 完全一致：主群一致 + 消息 ID 非空 + 源内容指纹匹配。
    // 指纹不匹配（`file` 覆盖上传）不得复用——否则新版本任务会从旧版本的主群消息中继，
    // 镜像群拿到旧内容而任务记为成功；不匹配时**不 return**，落到下方「接管重搬」路径
    // （删旧行 + 重新插入），按新内容重新搬运。
    const fingerprintMismatch = row.status === 'ready' && anchorChatId === mainChatId && !!anchorMessageId
      && !this.isSourceFingerprintMatch(input, row);
    if (row.status === 'ready' && anchorChatId === mainChatId) {
      if (anchorMessageId && !fingerprintMismatch) {
        return { chatId: mainChatId, messageId: anchorMessageId, planted: false };
      }
    }

    const reservedAtMs = row.plantedAt ? new Date(row.plantedAt).getTime() : 0;
    const leaseExpiresAtMs = reservedAtMs + PLANT_RESERVATION_LEASE_MS;
    const leaseExpired = !reservedAtMs || Date.now() >= leaseExpiresAtMs;
    if (row.status === 'pending' && !leaseExpired) {
      const remainingMs = Math.max(0, leaseExpiresAtMs - Date.now());
      throw new MirrorExecutionError(
        'main_chat_anchor_pending',
        `主群锚点正在搬运中（预留于 ${new Date(reservedAtMs).toISOString()}，`
        + `租约 ${Math.round(PLANT_RESERVATION_LEASE_MS / 60_000)} 分钟，`
        + `约 ${Math.ceil(remainingMs / 1000)} 秒后到期）：本轮按可重试处理以避免`
        + '主群出现重复消息，租约到期后重试会自动接管重搬',
        'retryable',
        // 把重试**排到租约到期之后**：否则若这条错误落在最后一次可重试的尝试上
        // （退避 240s < 租约 300s），下一次尝试仍会撞上未到期的预留，任务就此耗尽重试、
        // 锚点长期停在 pending，只能靠人工或新事件再次触发。
        remainingMs + PLANT_RETRY_AFTER_MARGIN_MS,
      );
    }
    if (row.status === 'pending') {
      this.pool?.bumpCounter('mainChatPlantTakeovers');
      this.logger.warn(
        `主群锚点预留超出租约（${input.ownerType}:${input.ownerId} / 主群 ${maskIdentifier(mainChatId)}，`
        + `预留于 ${new Date(reservedAtMs).toISOString()}）：接管重搬；`
        + '上一次搬运可能已在主群留下一条消息，请人工核对',
      );
    } else if (row.status === 'ready') {
      this.pool?.bumpCounter('mainChatPlantTakeovers');
      if (fingerprintMismatch) {
        // 源内容变更（同一 file.id 覆盖上传）：主群那条消息仍指向旧内容，必须按新
        // source 消息重搬。与「主群变更」分开留痕，便于运维区分两类重搬原因。
        this.logger.warn(
          `主群锚点源消息已变更（file:${input.ownerId} / 版本 ${input.sourceVersion ?? '未知'}）：`
          + `原 source 消息 ${maskIdentifier(row.sourceMessageId)} → 新 source 消息 ${maskIdentifier(input.sourceMessageId)}；`
          + '按新内容重新搬运，旧主群消息不再被使用，可人工清理',
        );
      } else {
        // 既有锚点不可再用：主群被改（管理员改了启用规则的源群）或锚点行缺消息 ID。
        // 这不是「上次中断」而是配置变更，但同样会让主群多出一条消息，必须留痕。
        this.logger.warn(
          `主群锚点不可复用，重新搬运一次（${input.ownerType}:${input.ownerId} / `
          + `锚点原指向 ${anchorChatId ? maskIdentifier(anchorChatId) : '空'}，现主群 ${maskIdentifier(mainChatId)}）：`
          + '旧主群中的那条消息不再被使用，可人工清理',
        );
      }
    }

    // 接管写入：**删除旧行 + 重新插入**，用唯一键做互斥（CAS），而不是原地更新。
    // 原地更新没有可靠的 CAS 判据：`affected` 行数在各驱动口径不一（项目规则禁止依赖它），
    // 日期列做等值比较又依赖各驱动的时间精度。唯一键冲突则是本文件已经在依赖的、
    // 跨方言一致的互斥原语——接管者各自删旧行再插入，只有插入成功的那一个持有预留，
    // 另一个会撞唯一键并按可重试收口，**绝不带着过期的判断去转发**。
    // 删除条件带 `status`：若旧行在这之间已被收口为 `ready`，删除匹配不到，随后的插入
    // 会撞唯一键并回读复用，同样不会重复搬运。
    try {
      await this.repo.delete({ id: row.id, status: row.status });
    } catch (error) {
      throw new MirrorExecutionError(
        'main_chat_anchor_unavailable',
        `主群锚点接管失败，已中止本轮扩散以避免重复搬运：`
        + `${error instanceof Error ? error.message : String(error)}`.slice(0, 400),
        'blocked',
      );
    }
    try {
      await this.repo.insert(this.repo.create(payload));
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isUniqueViolation(message)) {
        throw new MirrorExecutionError(
          'main_chat_anchor_unavailable',
          `主群锚点接管失败，已中止本轮扩散以避免重复搬运：${message}`.slice(0, 400),
          'blocked',
        );
      }
    }
    // 唯一键挡住了本调用：另一个执行者刚刚接管（或已完成），本轮按可重试收口。
    const current = await this.requireRow(input.ownerType, input.ownerId);
    const currentChatId = String(current.anchorChatId ?? '').trim();
    const currentMessageId = String(current.anchorMessageId ?? '').trim();
    // 回读复用同样必须过源内容指纹：并发执行者可能是**更早版本**的任务（例如覆盖上传后
    // 仍在收尾的旧任务），它抢到的锚点指向旧内容；此处若直接复用，本轮就会从旧消息中继，
    // 与「覆盖后镜像必须是新内容」相矛盾。指纹不匹配时按可重试收口——下一轮走到
    // `reserve()` 的 ready 分支即会接管重搬（删旧行 + 重新插入），收敛到新内容。
    if (
      current.status === 'ready'
      && currentChatId === mainChatId
      && currentMessageId
      && this.isSourceFingerprintMatch(input, current)
    ) {
      return { chatId: mainChatId, messageId: currentMessageId, planted: false };
    }
    if (current.status === 'ready' && currentChatId === mainChatId && currentMessageId) {
      throw new MirrorExecutionError(
        'main_chat_anchor_pending',
        '主群锚点已被另一个执行者收口为 ready，但其源消息与本轮源内容不一致'
        + '（疑似更早版本的任务抢先搬运）：本轮按可重试处理，下一轮将接管重搬以避免中继旧内容',
        'retryable',
      );
    }
    throw new MirrorExecutionError(
      'main_chat_anchor_pending',
      '主群锚点已被另一个执行者接管（预留已刷新），本轮按可重试处理以避免主群出现重复消息',
      'retryable',
    );
  }

  /** 真实搬运：由「持有该消息的 Bot 账号」把消息服务端转发进主群，并写回锚点 */
  private async plantToMainChat(
    input: EnsureMainChatAnchorInput,
    mainChatId: string,
    sourceChatId: string,
    sourceMessageId: string,
  ): Promise<MainChatAnchor> {
    // 双检：等待单飞期间可能已有其它调用完成搬运（判据与 ensureAnchor 一致，
    // 含源内容指纹校验：覆盖上传后的旧锚点不得在此被复用）
    const cached = await this.findReusable(input, mainChatId);
    if (cached) return cached;

    if (!this.client) {
      throw new MirrorExecutionError(
        'main_chat_client_unavailable',
        '账号级 Bot API 客户端未装配，无法把源消息搬运到主群',
        'blocked',
      );
    }
    const bot = await this.resolveHoldingBot(input.sourceAccountId ?? null);
    if (!bot) {
      throw new MirrorExecutionError(
        'main_chat_bot_unresolved',
        `无法确认收到该文件的 Bot 账号（sourceAccountId=${input.sourceAccountId ?? 'null'}）的可用凭据，`
        + '无法把源消息搬运到主群；请确认该账号仍启用且凭据可解密',
        'blocked',
      );
    }

    // 先落库再执行：预留成功（或安全接管）之后才允许产生主群消息。
    // 顺序不可交换——先转发再落库时，落库失败/进程崩溃会让重试找不到锚点，
    // 于是「重试 = 再搬一次 = 主群多一条重复消息」。
    const reusable = await this.reserve(input, mainChatId);
    if (reusable) return reusable;

    this.pool?.bumpCounter('mainChatPlantAttempts');
    let forwarded: { messageId: string };
    try {
      forwarded = await this.client.forwardMessage(
        bot.accountId,
        bot.token,
        mainChatId,
        sourceChatId,
        sourceMessageId,
      );
    } catch (error) {
      this.pool?.bumpCounter('mainChatPlantFailures');
      const summary = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await this.persistFailed(input, mainChatId, summary);
      this.logger.warn(
        `搬运到主群失败（${input.ownerType}:${input.ownerId} / 账号 ${maskIdentifier(bot.accountId)} / `
        + `主群 ${maskIdentifier(mainChatId)}）：${summary}`,
      );
      // 原样抛出：分类交给 `classifyMirrorError`（429 退避、权限/凭据 blocked）
      throw error;
    }

    const anchor: MainChatAnchor = { chatId: mainChatId, messageId: forwarded.messageId, planted: true };
    await this.persistReady(input, anchor, bot.accountId);
    this.logger.log(
      `已把源消息搬运到主群（${input.ownerType}:${input.ownerId} / 账号 ${maskIdentifier(bot.accountId)} / `
      + `主群 ${maskIdentifier(mainChatId)} / 消息 ${maskIdentifier(forwarded.messageId)}）`,
    );
    return anchor;
  }

  /**
   * 写入可用锚点（把预留行收口为 `ready`；源消息本就在主群时直接登记）。
   *
   * 写库失败**不回退已完成的搬运**（副作用已发生，抛错只会让下次重试再搬一次、
   * 在主群多留一条重复消息），因此这里只记 error 级日志，让运维在日志与主群里
   * 能看出「这次搬运没有落库」。残留的 `pending` 行会在租约到期后被下一次重试
   * 接管重搬（并 warn 提示人工核对主群），不会永久阻塞该文件的扩散。
   */
  private async persistReady(
    input: EnsureMainChatAnchorInput,
    anchor: MainChatAnchor,
    plantedByAccountId: string | null,
  ): Promise<void> {
    const payload = {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      anchorChatId: anchor.chatId,
      anchorMessageId: anchor.messageId,
      plantedByAccountId,
      sourceChatId: String(input.sourceChatId ?? '').trim() || null,
      sourceMessageId: String(input.sourceMessageId ?? '').trim() || null,
      status: 'ready' as const,
      lastError: null,
      plantedAt: new Date(),
    };
    try {
      await this.upsert(payload);
    } catch (error) {
      this.logger.error(
        `主群锚点写入失败（${input.ownerType}:${input.ownerId}）：`
        + `${error instanceof Error ? error.message : String(error)}`
        + '——该文件重试时会再次搬运一次并在主群留下重复消息，请关注主群消息与锚点表',
      );
    }
  }

  /** 记录搬运失败（保留失败原因供运维定位；不写 anchorMessageId） */
  private async persistFailed(
    input: EnsureMainChatAnchorInput,
    mainChatId: string,
    summary: string,
  ): Promise<void> {
    const payload = {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      anchorChatId: mainChatId,
      anchorMessageId: null,
      plantedByAccountId: null,
      sourceChatId: String(input.sourceChatId ?? '').trim() || null,
      sourceMessageId: String(input.sourceMessageId ?? '').trim() || null,
      status: 'failed' as const,
      lastError: summary,
      plantedAt: null,
    };
    // 失败行只是可观测证据：写不进去只记日志，绝不覆盖原始的搬运错误
    try {
      // `keepReady`：租约到期后被另一个执行者接管且搬运成功（行已 `ready`）时，
      // 本次（更早的、已超时的）搬运失败**不得**把成功的锚点改写成 `failed`——
      // 否则下一次重试会认为「失败无副作用残留」而立即再搬一次，在主群多留一条重复消息。
      await this.upsert(payload, { keepReady: true });
    } catch (error) {
      this.logger.warn(
        `主群锚点失败状态写入失败（${input.ownerType}:${input.ownerId}）：`
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Upsert（`(ownerType, ownerId)` 唯一）。
   *
   * 不用 `repo.upsert`：它依赖驱动端的 ON CONFLICT 支持，跨方言行为不一致。
   * 这里用「先查后更、竞态回退」的稳妥路径：唯一键冲突（并发插入）视为成功
   * ——锚点行已存在即达到目的。
   *
   * `keepReady` 用于**失败收口**：写入条件带 `status != 'ready'`，从而在 SQL 层
   * 一次性消除「先读后写」的竞态窗口（读到的行此刻仍是 `pending/failed`，写下去时
   * 已被接管者收口为 `ready`）。不读取 affected 行数，条件本身即保护。
   */
  private async upsert(
    payload: Pick<
      TelegramMainChatAnchor,
      'ownerType' | 'ownerId' | 'anchorChatId' | 'anchorMessageId' | 'plantedByAccountId'
      | 'sourceChatId' | 'sourceMessageId' | 'status' | 'lastError' | 'plantedAt'
    >,
    options: { keepReady?: boolean } = {},
  ): Promise<void> {
    const where = { ownerType: payload.ownerType, ownerId: payload.ownerId };
    const write = async (id: string): Promise<void> => {
      await this.repo.update(
        options.keepReady ? { id, status: Not('ready' as const) } : { id },
        payload,
      );
    };
    const existing = await this.repo.findOne({ where, select: ['id'] });
    if (existing) {
      await write(existing.id);
      return;
    }
    try {
      await this.repo.insert(this.repo.create(payload));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isUniqueViolation(message)) throw error;
      // 并发插入：锚点已由另一方写入，目标已达成
      const row = await this.repo.findOne({ where, select: ['id'] });
      if (!row) throw error;
      await write(row.id);
    }
  }

  /**
   * 解析搬运所需的 Bot 凭据：**只使用「收到该消息的那个账号」**，绝不跨账号代搬。
   *
   * 查找顺序：账号池配置（id 命中）→ 环境变量主 Bot（同 Token 时）→ 面板 Bot 账号。
   */
  private async resolveHoldingBot(poolAccountId: string | null): Promise<{ accountId: string; token: string } | null> {
    const wanted = (poolAccountId || '').trim();
    if (wanted && this.pool) {
      const config = this.pool.getConfig(wanted);
      if (config?.enabled && config.token) return { accountId: config.id, token: config.token };
    }
    const envToken = (this.configService?.get<string>('TELEGRAM_BOT_TOKEN') || '').trim();
    if (envToken.includes(':')) {
      const envBotId = envToken.split(':')[0];
      if (!wanted || wanted === envBotId) return { accountId: envBotId, token: envToken };
    }
    if (!this.accounts) return null;
    try {
      const panel = await this.accounts.resolveEnabledBotAccounts();
      const match = panel.find((item) => item.accountId === wanted || item.id === wanted);
      if (match) return { accountId: match.accountId, token: match.token };
    } catch (error) {
      this.logger.warn(`读取面板 Bot 账号失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }

  /** 私聊判定：Telegram 群/频道 chat id 恒为负数，用户 ID 为正数 */
  private isPrivateChat(chatId: string): boolean {
    const numeric = Number(chatId);
    return Number.isFinite(numeric) && numeric > 0;
  }
}
