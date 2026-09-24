import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { File } from '../common/entities/file.entity';
import {
  TelegramCopyOwnerType,
  TelegramCopySource,
  TelegramFileCopy,
} from '../common/entities/telegram-file-copy.entity';
import type {
  ReplicationAttemptStatus,
  UserRelayFailureReason,
} from '../common/entities/telegram-replication-attempt.entity';
import { TelegramAccountPoolService } from './telegram-account-pool.service';
import {
  attemptStatusForRelayFailure,
  BeginRoundResult,
  ReplicationAttemptService,
} from './replication-attempt.service';
import { UserRelayService } from './user-relay.service';

/** 副本覆盖率审计单次扫描的逻辑文件分组上限（管理端接口不得把全表拉进内存） */
export const REPLICATION_COVERAGE_MAX_GROUPS = 5000;

/**
 * 单次锚点解析最多读取的副本行数。
 *
 * 同一 `(chatId, messageId)` 命中的行数 = 该消息的逻辑主键数 × 各主键下的账号数；
 * 正常场景（一条消息、若干 Bot）远小于该上限。上限只用于防御异常脏数据
 * （例如历史数据把同一消息锚点写进了大量不同逻辑主键）把管理端/下载入口拖垮。
 */
export const ANCHOR_RESOLVE_MAX_ROWS = 200;

/** 多义锚点告警日志的最小间隔（毫秒）：避免异常数据把日志刷爆 */
const ANCHOR_CONFLICT_LOG_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 用户账号中继后的「入站认领」等待窗口与复查间隔（毫秒）。
 *
 * 取值依据：群内各 Bot 通过长轮询收 update，典型延迟秒级（轮询周期 + 网络）；
 * 窗口必须显著短于「下载期懒扩散」的等待容忍度（首个字节不能被复制阻塞）。
 * 故意不设成长时间等待：窗口之外由下一轮懒扩散继续补齐。
 *
 * **预发布压测后冻结**：窗口越长，认领越可能到齐，但下载期懒扩散占用的事件循环越久。
 */
const RELAY_CLAIM_WAIT_MS = 12_000;
const RELAY_CLAIM_POLL_MS = 1_500;

/**
 * 副本覆盖率的大小分档（从大到小）。
 *
 * 为什么以 4GiB 为最高档：生产事故正是「4GB 级分卷的副本全部集中在一个账号」，
 * 而所有分档按同一目标统计时，大量小文件的达标会把大文件的严重不达标「平均掉」，
 * 管理端看到的是「覆盖率 90%」——与真实风险完全不符。
 */
export const SIZE_COVERAGE_TIERS: Array<{ label: string; minBytes: number }> = [
  { label: '≥4GiB', minBytes: 4 * 1024 ** 3 },
  { label: '1–4GiB', minBytes: 1024 ** 3 },
  { label: '256MiB–1GiB', minBytes: 256 * 1024 ** 2 },
  { label: '<256MiB', minBytes: 1 },
];

/**
 * 单次桥接最多关联的逻辑文件数。
 *
 * `file_unique_id` 在站内**不是唯一键**（同一内容被上传两次会形成两条 `files` 记录），
 * 因此桥接是一对多。历史上传数据可能出现极端重复，这里设上限避免单条群消息触发大量写库。
 */
const MAX_BRIDGE_FILES = 8;

export interface CopyRecordInput {
  ownerType: TelegramCopyOwnerType;
  ownerId: string;
  accountId: string;
  telegramFileId: string;
  chatId?: string | null;
  messageId?: string | null;
  fileSize?: number | null;
  source: TelegramCopySource;
  status?: 'ready' | 'pending';
}

export interface ReplicationResult {
  /** 本轮收口状态（与 `telegram_replication_attempts.status` 同一套语义） */
  status: ReplicationAttemptStatus;
  /** 本轮**新增**的 ready 副本账号（不含轮次开始前已持有的） */
  created: string[];
  /** 仍缺副本的合格账号（缺口展示；不再对应任何排队中的上传任务） */
  missing: string[];
  /** 中继是否已成功转发（转发成功 ≠ 副本 ready，仍需 Bot 认领） */
  relayed: boolean;
  /** 标准化失败原因（阻塞与可重试失败共用；成功时为 undefined） */
  failureReason?: UserRelayFailureReason;
  /** 持久化轮次 ID（未落库时为 undefined） */
  attemptId?: string;
  /** 因退避窗口未到期而整轮跳过（未写轮次记录） */
  skipped?: boolean;
}

/**
 * 文件副本服务：多账号回源的「共享层」。
 *
 * **副本扩散只有一条执行方式（策略 B：用户账号服务端中继）**：
 * 由 MTProto 用户账号把源消息转发进副本可见群，群里各 bot（管理员/关闭隐私模式）
 * 各自收到更新 → 由入站链路登记自己的副本。只需一次转发流量，且**不发生文件字节的
 * 二次下载/上传**。
 *
 * 原「策略 A（从源 Bot 下载后向目标 Bot 上传）」已整体移除：它会在中继不可用时
 * 静默放大上传流量（N 个账号就是 N 次重传），且与下载争抢同一账号额度。
 * 现在中继不可用一律 fail-closed——写入明确的阻塞/失败状态并按指数退避重试。
 *
 * 并发安全：`(ownerType, ownerId, accountId)` 唯一 + 进程内 single-flight，
 * 保证同一文件不会被并发重复发起多轮中继。
 */
@Injectable()
export class FileCopyService {
  private readonly logger = new Logger(FileCopyService.name);
  /** 同一逻辑文件的批量扩散 single-flight：key=`ownerType:ownerId` → Promise（并发请求共享） */
  private readonly ensureCopiesInflight = new Map<string, Promise<ReplicationResult>>();

  constructor(
    @InjectRepository(TelegramFileCopy)
    private readonly repo: Repository<TelegramFileCopy>,
    private readonly pool: TelegramAccountPoolService,
    @Optional() @Inject(UserRelayService) private readonly relay: UserRelayService | null,
    /**
     * 站内逻辑文件仓库（入站副本桥接用）。
     *
     * 用 `@Optional()`：大量单测以 `new FileCopyService(repo, pool, relay)` 直接构造，
     * 桥接是可选增强能力，缺失时应静默跳过而非抛错。
     */
    @Optional() @InjectRepository(File) private readonly files: Repository<File> | null = null,
    /**
     * 扩散轮次持久化（可观测性底座）。
     *
     * 用 `@Optional()`：单测可直接构造本服务；缺失时扩散仍按状态机执行，
     * 只是不落库、后台看不到时间线（**绝不因为观测缺失而阻塞扩散本身**）。
     */
    @Optional() @Inject(ReplicationAttemptService)
    private readonly attempts: ReplicationAttemptService | null = null,
  ) {}

  // ---------------- 查询 ----------------

  async listReady(ownerType: TelegramCopyOwnerType, ownerId: string): Promise<TelegramFileCopy[]> {
    return this.repo.find({ where: { ownerType, ownerId, status: 'ready' } });
  }

  async readyAccountIds(ownerType: TelegramCopyOwnerType, ownerId: string): Promise<string[]> {
    const copies = await this.listReady(ownerType, ownerId);
    return copies.map((copy) => copy.accountId);
  }

  async find(ownerType: TelegramCopyOwnerType, ownerId: string, accountId: string): Promise<TelegramFileCopy | null> {
    return this.repo.findOne({ where: { ownerType, ownerId, accountId } });
  }

  /**
   * 按「入站锚点」反查副本：直链记录只存了 (chatId, messageId)（用户的私聊与消息），
   * 而副本的逻辑主键是 `file_unique_id`；同一用户消息只会被**一个** bot 收到，
   * 因此该锚点在库内唯一，可安全反查出逻辑主键与全部副本。
   *
   * 语义收紧（2026-09 计划 P1）：返回**唯一逻辑主键**而不是「任意一行」。
   *
   * 为什么必须收紧：`bridgeInboundCopyToLogicalFile` 是**双写**（`fileUnique` 记录保留、
   * 额外写 `file` 记录），因此同一 `(chatId, messageId)` 可以合法地命中多条不同
   * `ownerType/ownerId` 的行。历史实现在这种情形下取「第一行」，一旦数据库返回顺序变化，
   * 同一份文件的回源候选集合就会在 `fileUnique` 与 `file` 两个命名空间之间漂移——
   * 表现正是「副本明明存在，却总压在同一账号」这类无从复现的分布异常。
   *
   * 解析优先级（确定性，与双写方向一致）：
   * 1. `fileUnique`（跨账号稳定的 Telegram 逻辑主键，Bot 直链的真实锚点）；
   * 2. `file`（站内逻辑文件；由群认领桥接而来，同一 `file_unique_id` 可能对应多条站内文件）；
   * 3. `grant`（历史/直链锚点）。
   *
   * 同优先级内出现多个不同 `ownerId` 时**不做猜测**：按 `ownerId` 升序取第一个并告警，
   * 使结果稳定可复现（不会随数据库返回顺序漂移），同时把脏数据暴露出来供人工核查。
   * 全程 fail-closed：命中多行只会选一个逻辑主键，绝不跨账号共享 `file_id`。
   */
  async findByAnchor(chatId: string, messageId: string): Promise<TelegramFileCopy | null> {
    const rows = await this.repo.find({
      where: { chatId, messageId },
      take: ANCHOR_RESOLVE_MAX_ROWS,
    });
    if (rows.length === 0) return null;
    return this.pickAnchorWinner(rows, { chatId, messageId });
  }

  /**
   * 锚点候选行的确定性收敛（纯函数，便于测试与审计复用）。
   *
   * 多义锚点（同一 `(chatId, messageId)` 命中多个逻辑主键）时返回稳定结果并计数：
   * 计数用于告警/审计，避免只在日志里留下一次性噪声。
   */
  private pickAnchorWinner(
    rows: TelegramFileCopy[],
    anchor: { chatId: string; messageId: string },
  ): TelegramFileCopy | null {
    if (rows.length === 1) return rows[0];
    const order: Record<TelegramCopyOwnerType, number> = { fileUnique: 0, file: 1, grant: 2 };
    const sorted = [...rows].sort((left, right) => {
      const byType = order[left.ownerType] - order[right.ownerType];
      if (byType !== 0) return byType;
      const byOwner = String(left.ownerId).localeCompare(String(right.ownerId));
      if (byOwner !== 0) return byOwner;
      return String(left.accountId).localeCompare(String(right.accountId));
    });
    const winner = sorted[0];
    const distinctKeys = new Set(sorted.map((row) => `${row.ownerType}:${row.ownerId}`));
    if (distinctKeys.size > 1) {
      this.bumpAnchorConflict();
      this.warnAnchorConflictOnce(
        `同一入站锚点命中 ${distinctKeys.size} 个逻辑主键（chat=${anchor.chatId} message=${anchor.messageId}），`
        + `已按确定性优先级解析为 ${winner.ownerType}:${this.preview(winner.ownerId)}；`
        + '若该文件确有多个站内副本，请核查副本归属是否需要人工合并',
      );
    }
    return winner;
  }

  /** 多义锚点累计次数（进程内，供审计与告警判定） */
  private anchorConflicts = 0;
  private lastAnchorConflictLogAt = 0;

  get anchorConflictCount(): number {
    return this.anchorConflicts;
  }

  /** 多义锚点告警：计数 + 限频日志（异常数据不得把日志刷爆） */
  private warnAnchorConflictOnce(message: string): void {
    const now = Date.now();
    if (now - this.lastAnchorConflictLogAt < ANCHOR_CONFLICT_LOG_INTERVAL_MS) return;
    this.lastAnchorConflictLogAt = now;
    this.logger.warn(message);
  }

  private bumpAnchorConflict(): void {
    this.anchorConflicts += 1;
    try {
      this.pool.bumpCounter('anchorConflicts');
    } catch {
      // 账号池未装配（单测）时忽略：锚点冲突计数是诊断量，不得影响回源
    }
  }

  // ---------------- 入站副本 → 站内文件桥接（副本扩散的「最后一公里」） ----------------

  /**
   * 把「某账号在群内认领的入站副本」桥接为**站内逻辑文件**的副本记录。
   *
   * 为什么必须有这一步：入站登记以 Telegram 跨账号稳定的 `file_unique_id` 为逻辑主键
   * （`ownerType='fileUnique'`），而站内下载/媒体直链只按站内 `file.id` 查副本
   * （`ownerType='file'`）。两套命名空间互不相通时，副本可见群里各 Bot 认领到的副本
   * **永远不会被下载选号消费**——负载均衡就无从发生。
   *
   * 做法：用 `file_unique_id` 反查 `files.telegramFileUniqueId`，命中后为每个逻辑文件
   * **额外**写一条 `ownerType='file'` 副本；原 `fileUnique` 记录**保留不动**，
   * 以兼容 Bot 直链路径的 `findByAnchor` 语义（双写而非替换，回滚成本最低）。
   *
   * 红线：`telegramFileId` 必须是 `accountId` **自己产生的** `file_id`，禁止跨账号借用
   * （调用方只能传「该账号从自己收到的消息里取到的 file_id」）。
   *
   * 未命中（非站内文件 / 历史数据缺列）时返回 `bridged=false`，不抛错、不影响入站主流程。
   */
  async bridgeInboundCopyToLogicalFile(params: {
    fileUniqueId: string;
    accountId: string;
    telegramFileId: string;
    chatId: string;
    messageId: string;
    fileSize?: number | null;
    /**
     * 副本来源标注：命中站内逻辑文件且消息来自**启用中的镜像规则目标群**时传 `relayed`，
     * 其余（备份群/归档群的普通入站消息）保持默认 `inbound`。
     *
     * 为什么必须区分：`relayed` 是「副本扩散真的生效了」的证据，而 `inbound` 只是
     * 「某个 Bot 看到了这条消息」。把两者混在一起，后台就无法回答「中继到底有没有产生副本」。
     */
    source?: Extract<TelegramCopySource, 'inbound' | 'relayed'>;
  }): Promise<{ bridged: boolean; matchedFileIds: string[] }> {
    const result: { bridged: boolean; matchedFileIds: string[] } = { bridged: false, matchedFileIds: [] };
    const fileUniqueId = (params.fileUniqueId || '').trim();
    if (!fileUniqueId || !this.files) return result;
    const source: Extract<TelegramCopySource, 'inbound' | 'relayed'> = params.source ?? 'inbound';

    let matches: Array<{ id: string }>;
    try {
      matches = await this.files.find({
        where: { telegramFileUniqueId: fileUniqueId },
        select: ['id'],
        take: MAX_BRIDGE_FILES,
      });
    } catch (error) {
      this.logger.warn(
        `入站副本桥接反查失败（fileUnique=${this.preview(fileUniqueId)}）：`
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return result;
    }
    if (matches.length === 0) return result;

    for (const match of matches) {
      try {
        await this.upsertReady({
          ownerType: 'file',
          ownerId: match.id,
          accountId: params.accountId,
          telegramFileId: params.telegramFileId,
          chatId: params.chatId,
          messageId: params.messageId,
          fileSize: params.fileSize ?? null,
          source,
        });
        result.matchedFileIds.push(match.id);
      } catch (error) {
        // 单条失败不影响其它逻辑文件（同一 file_unique_id 可能是历史重复上传的多条记录）
        this.logger.warn(
          `入站副本桥接写入失败（file=${match.id}，账号 ${params.accountId}）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    result.bridged = result.matchedFileIds.length > 0;
    if (result.bridged) {
      this.logger.log(
        `入站副本已桥接到站内文件：账号 ${params.accountId} / fileUnique=${this.preview(fileUniqueId)}`
        + ` → ${result.matchedFileIds.length} 个逻辑文件`,
      );
    }
    return result;
  }

  // ---------------- 写入（幂等） ----------------

  /**
   * 副本来源合并规则：语义强度 `relayed` > `replicated` > `inbound`，**只升不降**。
   *
   * 为什么不能后写覆盖：同一账号可能先后因不同来源登记同一个 owner（例如中继扩散后
   * 用户又把同一文件发进非镜像群）。若允许降级，`relayed` 会被 `inbound` 覆盖，
   * 后台的「扩散是否真的生效」就失去了可信证据。
   */
  private mergeCopySource(current: TelegramCopySource, incoming: TelegramCopySource): TelegramCopySource {
    const rank: Record<TelegramCopySource, number> = { inbound: 0, replicated: 1, relayed: 2 };
    return rank[incoming] >= rank[current] ? incoming : current;
  }

  /** 登记/更新副本（同 owner+account 覆盖，重投幂等） */
  async upsertReady(input: CopyRecordInput): Promise<TelegramFileCopy> {
    const existing = await this.find(input.ownerType, input.ownerId, input.accountId);
    if (existing) {
      existing.telegramFileId = input.telegramFileId;
      existing.chatId = input.chatId ?? existing.chatId;
      existing.messageId = input.messageId ?? existing.messageId;
      existing.fileSize = input.fileSize != null ? String(input.fileSize) : existing.fileSize;
      // source 只升不降：`relayed` 是「中继扩散确实生效」的唯一证据，
      // 不能被后续一次非中继来源的重复登记（inbound / replicated）抹掉。
      existing.source = this.mergeCopySource(existing.source, input.source);
      existing.status = input.status ?? 'ready';
      existing.lastError = null;
      return this.repo.save(existing);
    }
    return this.repo.save(this.repo.create({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      accountId: input.accountId,
      telegramFileId: input.telegramFileId,
      chatId: input.chatId ?? null,
      messageId: input.messageId ?? null,
      fileSize: input.fileSize != null ? String(input.fileSize) : null,
      source: input.source,
      status: input.status ?? 'ready',
      lastError: null,
    }));
  }

  async touchUsed(copy: TelegramFileCopy): Promise<void> {
    try {
      await this.repo.update({ id: copy.id }, { lastUsedAt: new Date() });
    } catch {
      // 统计性字段，失败不影响下载
    }
  }

  // ---------------- 选择与扩散 ----------------

  /**
   * 计算「应当持有副本但仍未持有」的合格账号（**纯查询，无任何副作用**）。
   *
   * 语义变更（策略 A 移除后）：本方法**不再占位、不再排队上传**，只用于
   * 「缺口展示」——后台需要回答「还差哪几个账号」，但扩散的执行与收敛
   * 完全由 `ensureCopies` 的中继状态机负责。
   *
   * 为什么去掉 claim：原 claim 表是为了让并发的上传任务互斥同一个目标账号；
   * 现在扩散不再按账号逐个上传，占位只会让账号在 TTL 内无法被其它请求选中，
   * 属于纯副作用。
   *
   * @param desiredCount 期望的副本总数（由 `ReplicaTargetResolver` 解析并收敛）
   * @param sourceAccountId 源账号（绝不作为自己的扩散目标）
   */
  async planTargets(
    ownerType: TelegramCopyOwnerType,
    ownerId: string,
    desiredCount: number,
    sourceAccountId?: string,
  ): Promise<string[]> {
    const held = new Set(await this.readyAccountIds(ownerType, ownerId));
    const need = Math.max(0, desiredCount - held.size);
    if (need === 0) return [];
    const candidates = this.eligibleTargets(held, sourceAccountId);
    return candidates.slice(0, need);
  }

  /**
   * 可承载副本的候选账号（含排除原因）。
   *
   * 与「下载选号」共用同一份账号运行态快照：冷却/在飞上限必须在这里被尊重，
   * 否则缺口展示会把「当前根本不可调度」的账号算成「可以补副本」。
   *
   * 说明（策略 A 移除后）：`heldAccountIds` 与 `sourceAccountId` 都由调用方传入，
   * 方法本身是**纯函数**——不再读取任何进程内 claim 状态。
   */
  evaluateTargetEligibility(
    heldAccountIds: string[],
    sourceAccountId?: string,
  ): Array<{ accountId: string; eligible: boolean; reasons: string[] }> {
    const held = new Set(heldAccountIds);
    const source = (sourceAccountId || '').trim();
    return this.pool.snapshot().accounts.map((account) => {
      const reasons: string[] = [];
      if (!account.enabled) reasons.push('账号已禁用');
      // 只按「该账号自己是否配置了存储 Chat」判定：
      // `storageAccountIds()` 还要求 enabled，直接复用会把「已禁用」误报成「未配置存储 Chat」。
      if (!account.storageConfigured) reasons.push('未配置存储 Chat');
      if (account.coolingDown) reasons.push('账号冷却中');
      if (account.inflight >= account.maxInflight) reasons.push('已达在飞上限');
      if (source && account.id === source) reasons.push('与源账号相同');
      if (held.has(account.id)) reasons.push('已持有 ready 副本');
      return { accountId: account.id, eligible: reasons.length === 0, reasons };
    });
  }

  /** 过滤出可承载副本的候选账号 id（顺序沿用账号池快照顺序） */
  private eligibleTargets(
    held: Set<string>,
    sourceAccountId: string | undefined,
  ): string[] {
    return this.evaluateTargetEligibility(Array.from(held), sourceAccountId)
      .filter((item) => item.eligible)
      .map((item) => item.accountId);
  }

  /**
   * 副本覆盖率概览（管理端审计用）：
   * - 按「逻辑文件 → 去重后的 ready 账号数」分组统计满足/未满足目标的数量；
   * - 返回未满足目标文件的缺失样例（升序取前 N 条）。
   *
   * 有界性：分组行数按 `maxGroups` 截断（覆盖率达标的文件可能很多，
   * 管理端接口不应把全表分组结果一次性拉进内存），截断时返回 `truncated=true`。
   */
  async replicationCoverage(params: {
    ownerType: TelegramCopyOwnerType;
    target: number;
    maxGroups?: number;
    sampleLimit?: number;
  }): Promise<{
    /** 本次扫描到的「有 ready 副本的逻辑文件」数 */
    scannedFiles: number;
    satisfied: number;
    unsatisfied: number;
    truncated: boolean;
    missingSamples: Array<{ ownerId: string; readyAccountCount: number; missing: number }>;
  }> {
    const target = Math.max(1, Math.floor(params.target) || 1);
    const maxGroups = Math.max(1, Math.floor(params.maxGroups ?? REPLICATION_COVERAGE_MAX_GROUPS));
    const sampleLimit = Math.max(1, Math.floor(params.sampleLimit ?? 20));

    // 多取一行用于判定「是否被上限截断」；ORDER BY ownerId 让截断结果稳定可复现
    const rows = await this.repo
      .createQueryBuilder('copy')
      .select('copy.ownerId', 'ownerId')
      .addSelect('COUNT(DISTINCT copy.accountId)', 'readyAccountCount')
      .where('copy.ownerType = :ownerType', { ownerType: params.ownerType })
      .andWhere('copy.status = :status', { status: 'ready' })
      .groupBy('copy.ownerId')
      .orderBy('copy.ownerId', 'ASC')
      .limit(maxGroups + 1)
      .getRawMany<{ ownerId: string; readyAccountCount: string }>();

    const truncated = rows.length > maxGroups;
    const counts = rows.slice(0, maxGroups).map((row) => ({
      ownerId: row.ownerId,
      readyAccountCount: Number(row.readyAccountCount) || 0,
    }));
    const unsatisfiedItems = counts
      .filter((item) => item.readyAccountCount < target)
      .sort((a, b) => a.readyAccountCount - b.readyAccountCount);

    return {
      scannedFiles: counts.length,
      satisfied: counts.length - unsatisfiedItems.length,
      unsatisfied: unsatisfiedItems.length,
      truncated,
      missingSamples: unsatisfiedItems.slice(0, sampleLimit).map((item) => ({
        ownerId: item.ownerId,
        readyAccountCount: item.readyAccountCount,
        missing: target - item.readyAccountCount,
      })),
    };
  }

  /**
   * 副本覆盖率概览（按**文件大小分层**，管理端审计用）。
   *
   * 为什么需要单独一层：`replicationCoverage` 只回答「达标/未达标」，
   * 而生产的核心问题是**大文件**的副本分布（4GB+ 分卷全部集中在单一账号，
   * 该账号独扛 DC-5 回源）。按大小分层后，才能直接读出
   * 「≥4GiB 的逻辑文件有多少个、其中有多少达到目标副本数」。
   *
   * 口径说明：
   * - 分组键是「逻辑主键（`ownerType:ownerId`）+ 大小分档」，跨命名空间不合并；
   * - `fileSize` 为空的副本不计入任何分档（缺大小无法判定，宁可少算不可错算）；
   * - 分组按 `fileSize` 取最大值（同一逻辑主键的副本大小应当一致，取最大值偏保守）；
   * - 扫描有界：`LIMIT maxGroups + 1`，并返回 `truncated` 提示统计不完整。
   */
  async replicationCoverageBySize(params: {
    ownerType: TelegramCopyOwnerType;
    /** 目标副本数 */
    target: number;
    /** 分档下界（字节，含），按从大到小排列 */
    tiers?: Array<{ label: string; minBytes: number }>;
    maxGroups?: number;
    sampleLimit?: number;
  }): Promise<{
    scannedFiles: number;
    truncated: boolean;
    tiers: Array<{
      label: string;
      minBytes: number;
      files: number;
      satisfied: number;
      unsatisfied: number;
      /** 该档内「持有副本的去重账号数」分布（用于验证压力是否已分散） */
      readyAccountCounts: number[];
      missingSamples: Array<{ ownerId: string; readyAccountCount: number; missing: number }>;
    }>;
  }> {
    const target = Math.max(1, Math.floor(params.target) || 1);
    const maxGroups = Math.max(1, Math.floor(params.maxGroups ?? REPLICATION_COVERAGE_MAX_GROUPS));
    const sampleLimit = Math.max(1, Math.floor(params.sampleLimit ?? 20));
    const tiers = params.tiers ?? SIZE_COVERAGE_TIERS;

    // 按「逻辑主键」分组取最大已知大小与去重账号数。
    // 用 MAX(fileSize) 而非 AVG：分档边界必须确定性可复现。
    const rows = await this.repo
      .createQueryBuilder('copy')
      .select('copy.ownerId', 'ownerId')
      .addSelect('MAX(copy.fileSize)', 'maxSize')
      .addSelect('COUNT(DISTINCT copy.accountId)', 'readyAccountCount')
      .where('copy.ownerType = :ownerType', { ownerType: params.ownerType })
      .andWhere('copy.status = :status', { status: 'ready' })
      .andWhere('copy.fileSize IS NOT NULL')
      .groupBy('copy.ownerId')
      .orderBy('copy.ownerId', 'ASC')
      .limit(maxGroups + 1)
      .getRawMany<{ ownerId: string; maxSize: string | null; readyAccountCount: string }>();

    const truncated = rows.length > maxGroups;
    const result = tiers.map((tier) => ({
      label: tier.label,
      minBytes: tier.minBytes,
      files: 0,
      satisfied: 0,
      unsatisfied: 0,
      readyAccountCounts: [] as number[],
      missingSamples: [] as Array<{ ownerId: string; readyAccountCount: number; missing: number }>,
    }));

    let scannedFiles = 0;
    for (const row of rows.slice(0, maxGroups)) {
      const size = Number(row.maxSize);
      if (!Number.isFinite(size) || size <= 0) continue;
      const index = tiers.findIndex((tier) => size >= tier.minBytes);
      if (index < 0) continue;
      const readyAccountCount = Number(row.readyAccountCount) || 0;
      scannedFiles += 1;
      const bucket = result[index];
      bucket.files += 1;
      bucket.readyAccountCounts.push(readyAccountCount);
      if (readyAccountCount >= target) {
        bucket.satisfied += 1;
      } else {
        bucket.unsatisfied += 1;
        bucket.missingSamples.push({
          ownerId: row.ownerId,
          readyAccountCount,
          missing: target - readyAccountCount,
        });
      }
    }
    for (const bucket of result) {
      bucket.readyAccountCounts.sort((left, right) => left - right);
      bucket.missingSamples = bucket.missingSamples
        .sort((left, right) => left.readyAccountCount - right.readyAccountCount)
        .slice(0, sampleLimit);
    }
    return { scannedFiles, truncated, tiers: result };
  }

  /**
   * **高热大文件**（≥`minBytes`）的可用账号分布（容量策略闸门用）。
   *
   * 与 `countReadyByAccount()` 的区别（这是「单账号独扛」问题的核心）：
   * 后者统计「某账号在**任意**文件上存在一条 ready 副本」——一个账号只要随便
   * 持有一个小文件副本就会被算作「有效 Bot」，于是自动预算会在大文件副本仍
   * 全部集中在一个账号时照样从 8 升到 16，把 DC-5 压力继续堆到同一个账号。
   *
   * 本方法只看**达到大小阈值**的逻辑文件：返回这些文件的去重账号覆盖情况。
   * 判据（调用方使用）：`files` 数量 > 0 时，要求
   * `minReadyAccounts`（该批文件里覆盖最少的账号数）达到目标，才允许升档。
   *
   * 有界：按 `LIMIT maxGroups + 1` 截断，返回 `truncated` 表示统计不完整
   * （调用方应保守处理，不据此升档）。
   */
  async largeFileReplicaDistribution(params: {
    ownerType?: TelegramCopyOwnerType;
    minBytes: number;
    maxGroups?: number;
  }): Promise<{
    files: number;
    truncated: boolean;
    /** 每个逻辑文件的去重 ready 账号数（升序，便于直接读最小值/中位数） */
    readyAccountCounts: number[];
    /** 覆盖最少的账号数（无大文件时为 0） */
    minReadyAccounts: number;
  }> {
    const maxGroups = Math.max(1, Math.floor(params.maxGroups ?? REPLICATION_COVERAGE_MAX_GROUPS));
    const qb = this.repo
      .createQueryBuilder('copy')
      .select('copy.ownerType', 'ownerType')
      .addSelect('copy.ownerId', 'ownerId')
      .addSelect('MAX(copy.fileSize)', 'maxSize')
      .addSelect('COUNT(DISTINCT copy.accountId)', 'readyAccountCount')
      .where('copy.status = :status', { status: 'ready' })
      .andWhere('copy.fileSize IS NOT NULL');
    if (params.ownerType) qb.andWhere('copy.ownerType = :ownerType', { ownerType: params.ownerType });
    const rows = await qb
      .groupBy('copy.ownerType')
      .addGroupBy('copy.ownerId')
      .orderBy('copy.ownerId', 'ASC')
      .limit(maxGroups + 1)
      .getRawMany<{ ownerType: string; ownerId: string; maxSize: string | null; readyAccountCount: string }>();

    const counts: number[] = [];
    for (const row of rows.slice(0, maxGroups)) {
      const size = Number(row.maxSize);
      if (!Number.isFinite(size) || size < params.minBytes) continue;
      counts.push(Number(row.readyAccountCount) || 0);
    }
    counts.sort((left, right) => left - right);
    return {
      files: counts.length,
      truncated: rows.length > maxGroups,
      readyAccountCounts: counts,
      minReadyAccounts: counts.length > 0 ? counts[0] : 0,
    };
  }

  /**
   * 各账号持有的 ready 副本数（按 `ownerType` 可选过滤）。
   *
   * 供两处使用：
   * - 管理端副本资格审计（覆盖率与账号分布）；
   * - 容量策略的 `activeBotCount`（账号是否至少存在一个自己的 ready 副本）。
   *
   * 用 QueryBuilder 分组（无方言特有函数），并同时兼容 PG 与 SQLite。
   */
  async countReadyByAccount(ownerType?: TelegramCopyOwnerType): Promise<Map<string, number>> {
    const qb = this.repo
      .createQueryBuilder('copy')
      .select('copy.accountId', 'accountId')
      .addSelect('COUNT(*)', 'count')
      .where('copy.status = :status', { status: 'ready' });
    if (ownerType) qb.andWhere('copy.ownerType = :ownerType', { ownerType });
    const rows = await qb.groupBy('copy.accountId').getRawMany<{ accountId: string; count: string }>();
    return new Map(rows.map((row) => [row.accountId, Number(row.count) || 0]));
  }

  /**
   * 副本记录生命周期清理（策略定义）。
   *
   * 为什么需要：副本表是「逻辑文件 → 账号 → file_id」的映射，会随扩散失败、账号摘除、
   * 文件删除与长期无人访问持续增长；不清理会拖慢查询并放大备份体积。
   *
   * 清理规则（全部按「超过阈值」判定，绝不删除近期记录）：
   * - `failed` 且超过 `failedBefore` 未更新：重试窗口已过；
   * - `pending` 且超过 `pendingBefore` 未更新：复制中断留下的悬挂记录；
   * - `ready` 且 `lastUsedAt` 早于 `staleReadyBefore`：长期未被回源使用的陈旧副本；
   * - `ready` 且从未使用、`createdAt` 早于 `staleReadyBefore`：入站登记后从未被下载。
   *
   * 说明：本表与站内文件体系解耦（不建外键），因此不做「删文件即删副本」的联动，
   * 统一由时间阈值收敛；需要更快收敛时缩短阈值即可，无需改代码。
   */
  async purgeStale(params: {
    failedBefore: Date;
    pendingBefore: Date;
    staleReadyBefore: Date;
  }): Promise<{ failed: number; pending: number; staleReadyUsed: number; staleReadyUnused: number }> {
    const failed = await this.repo.delete({ status: 'failed', updatedAt: LessThan(params.failedBefore) });
    const pending = await this.repo.delete({ status: 'pending', updatedAt: LessThan(params.pendingBefore) });
    const staleReadyUsed = await this.repo.delete({
      status: 'ready',
      lastUsedAt: LessThan(params.staleReadyBefore),
    });
    const staleReadyUnused = await this.repo.delete({
      status: 'ready',
      lastUsedAt: IsNull(),
      createdAt: LessThan(params.staleReadyBefore),
    });
    const result = {
      failed: failed.affected ?? 0,
      pending: pending.affected ?? 0,
      staleReadyUsed: staleReadyUsed.affected ?? 0,
      staleReadyUnused: staleReadyUnused.affected ?? 0,
    };
    if (result.failed || result.pending || result.staleReadyUsed || result.staleReadyUnused) {
      this.logger.log(
        `副本清理完成：failed=${result.failed} pending=${result.pending}`
        + ` staleReady(已用)=${result.staleReadyUsed} staleReady(未用)=${result.staleReadyUnused}`,
      );
    }
    return result;
  }

  /**
   * 确保副本达标（**策略 B 单链路**，fail-closed 状态机）。
   *
   * 执行顺序（每一步都会落成可查询的轮次状态，不再有静默跳过）：
   * 1. 缺口计算：已达标直接返回 `succeeded`，**不写轮次**（无工作可做）；
   * 2. 前置能力校验：中继未启用 / 源锚点缺失 / 目标群未配置 → 直接收口为 `blocked_*`；
   * 3. 幂等中继：服务端转发（重试不产生重复群消息）；
   * 4. 有界认领等待：转发成功 ≠ 副本 ready，必须等 Bot 认领；
   * 5. 落状态：`succeeded` / `partial_success` / `claim_timeout` / `retryable_failed`。
   *
   * **绝不发生文件字节的二次下载/上传**：中继不可用时只写失败状态并退避重试，
   * 已有副本的下载不受影响（文件始终可用，只是不再产生新副本）。
   *
   * single-flight 语义：并发调用共享同一轮结果；缺口由下一轮懒扩散继续补齐。
   */
  async ensureCopies(params: {
    ownerType: TelegramCopyOwnerType;
    ownerId: string;
    desiredCount: number;
    sourceAccountId?: string;
    /**
     * 手动重试（后台显式操作）。
     *
     * 语义差异：跳过退避窗口与合并窗口、新建轮次并记录操作人与来源轮次。
     * 但**不绕过** single-flight——若已有轮次在途，先等它收口再强制新开一轮，
     * 否则手动重试会被在途轮次合并后又被退避跳过（表现为「点了重试没反应」）。
     */
    manualRetry?: { operatorUserId: string; retriedFromId: string };
  }): Promise<ReplicationResult> {
    const key = `${params.ownerType}:${params.ownerId}`;
    const running = this.ensureCopiesInflight.get(key);
    if (running) {
      if (!params.manualRetry) return running;
      // 手动重试：等在途轮次收口（不继承其结果），随后强制新开一轮。
      // 等待期间可能又有人开了新轮次，必须重新检查——否则会并发两轮中继。
      await running.catch(() => undefined);
      const pending = this.ensureCopiesInflight.get(key);
      if (pending && pending !== running) await pending.catch(() => undefined);
    }

    const task = this.doEnsureCopies(params).finally(() => {
      // 只清理自己的任务：无条件 delete 会把后来者的在途任务从 map 摘掉，
      // 之后任何人都会再开一轮 → single-flight 失效。
      if (this.ensureCopiesInflight.get(key) === task) this.ensureCopiesInflight.delete(key);
    });
    this.ensureCopiesInflight.set(key, task);
    return task;
  }

  /** 状态机实现（见 `ensureCopies` 的执行顺序说明） */
  private async doEnsureCopies(params: {
    ownerType: TelegramCopyOwnerType;
    ownerId: string;
    desiredCount: number;
    sourceAccountId?: string;
    manualRetry?: { operatorUserId: string; retriedFromId: string };
  }): Promise<ReplicationResult> {
    const { ownerType, ownerId } = params;
    const desired = Math.max(1, Math.floor(params.desiredCount) || 1);
    const result: ReplicationResult = {
      status: 'planned',
      created: [],
      missing: [],
      relayed: false,
    };

    // 1) 缺口计算：达标即结束，不写轮次（否则「健康文件」会持续制造无意义事件行）
    const held = await this.readyAccountIds(ownerType, ownerId);
    if (held.length >= desired) {
      result.status = 'succeeded';
      return result;
    }

    // 源锚点：中继必须持有 (chatId, messageId)，且该消息所在的群要对用户账号可读
    const sources = await this.listReady(ownerType, ownerId);
    const anchor = (params.sourceAccountId
      ? sources.find((item) => item.accountId === params.sourceAccountId)
      : undefined) ?? sources[0] ?? null;
    const anchorChatId = (anchor?.chatId || '').trim();
    const anchorMessageId = (anchor?.messageId || '').trim();
    // 目标群唯一权威：启用中的镜像规则（不再回退归档群，见 UserRelayService.resolveTargetChatId）
    const targetChatId = (await this.relay?.resolveTargetChatId() ?? '').trim();

    const begin = await this.attempts?.beginRound({
      ownerType,
      ownerId,
      sourceAccountId: anchor?.accountId ?? params.sourceAccountId ?? null,
      targetChatId: targetChatId || null,
      idempotencyKey: `copy:${ownerType}:${ownerId}`,
      desiredCount: desired,
      baselineReadyCount: held.length,
      force: Boolean(params.manualRetry),
      triggeredBy: params.manualRetry ? 'manual' : 'lazy',
      operatorUserId: params.manualRetry?.operatorUserId ?? null,
      retriedFromId: params.manualRetry?.retriedFromId ?? null,
    }) ?? null;

    if (begin?.skipped) {
      // 退避窗口未到期：整轮跳过且不写行（这是行数控制与限流保护的主要手段）
      result.skipped = true;
      result.status = 'planned';
      result.missing = await this.planTargets(ownerType, ownerId, desired, params.sourceAccountId);
      return result;
    }
    result.attemptId = begin?.attempt?.id ?? undefined;

    // 2) 前置能力校验：不满足即收口为 blocked_*，绝不进入任何字节传输路径
    const blocker = this.evaluateRelayBlockers({
      relayAvailable: Boolean(this.relay),
      relayEnabled: this.relay?.isEnabledByConfig() ?? false,
      targetChatId,
      anchorChatId,
      anchorMessageId,
    });
    if (blocker) {
      await this.settleBlockedRound(begin, blocker.status, blocker.reason, blocker.summary, desired, held.length);
      result.status = blocker.status;
      result.failureReason = blocker.reason;
      result.missing = await this.planTargets(ownerType, ownerId, desired, params.sourceAccountId);
      this.logger.log(
        `副本扩散阻塞（${ownerType}:${ownerId} / ${blocker.reason}）：${blocker.summary}`
        + '——策略 B 为唯一链路，不产生任何字节二次传输',
      );
      return result;
    }

    // 3) 幂等中继
    if (result.attemptId) await this.attempts?.markRelayStarted(result.attemptId);
    const relayed = await this.relay!.relay({
      sourceChatId: anchorChatId,
      sourceMessageId: anchorMessageId,
      targetChatId,
      idempotencyKey: `copy:${ownerType}:${ownerId}`,
      // 重试尽量落回上一轮的执行账号：`random_id` 由「幂等键 + 执行账号」派生，
      // 只有同账号重试才能命中服务端去重（不产生重复群消息）。账号不可用时
      // `pickUserAccount` 会确定性回落并在日志中告警——那种情况下去重不再成立。
      preferredAccountId: begin?.previousRelayAccountId ?? undefined,
    });
    if (!relayed.ok) {
      const reason: UserRelayFailureReason = relayed.reason ?? 'unknown';
      const status = attemptStatusForRelayFailure(reason);
      await this.settleBlockedRound(
        begin,
        status,
        reason,
        relayed.detail ?? `中继失败（${reason}）`,
        desired,
        held.length,
      );
      result.status = status;
      result.failureReason = reason;
      result.missing = await this.planTargets(ownerType, ownerId, desired, params.sourceAccountId);
      this.logger.warn(`副本扩散中继失败（${ownerType}:${ownerId} / ${reason}）：${relayed.detail ?? '无详情'}`);
      return result;
    }

    // 4) 有界认领等待：转发成功 ≠ 副本 ready
    const claimDeadlineAt = new Date(Date.now() + RELAY_CLAIM_WAIT_MS);
    if (result.attemptId) {
      await this.attempts?.markRelaySucceeded(result.attemptId, {
        relayAccountId: relayed.accountId ?? '',
        relayMessageId: relayed.messageId ?? null,
        claimDeadlineAt,
      });
    }
    const claimed = await this.waitForRelayClaims(ownerType, ownerId, held.length, desired);

    // 5) 落状态：新增 ≥1 个 ready 副本 = partial_success；达到目标 = succeeded；零新增 = claim_timeout
    result.relayed = true;
    result.created = claimed.filter((accountId) => !held.includes(accountId));
    result.missing = await this.planTargets(ownerType, ownerId, desired, params.sourceAccountId);

    if (result.attemptId) {
      const settled = await this.attempts?.settleClaims(result.attemptId, {
        desiredCount: desired,
        baselineReadyCount: held.length,
        readyAccountIds: claimed,
      });
      result.status = settled?.status ?? this.deriveClaimStatus(claimed, held.length, desired);
    } else {
      result.status = this.deriveClaimStatus(claimed, held.length, desired);
    }

    if (result.status === 'claim_timeout' || result.status === 'blocked_manual') {
      this.pool.bumpCounter('relayClaimsMissed');
      this.logger.warn(
        `用户账号中继转发成功但无人认领（${ownerType}:${ownerId}，`
        + `等待 ${RELAY_CLAIM_WAIT_MS}ms 内 ready 副本数未增加）：`
        + '请核查群内 Bot 是否已加入、隐私模式是否已关闭、入站轮询是否开启',
      );
    } else {
      this.logger.log(
        `用户账号中继已生效：${ownerType}:${ownerId} 新增 ${result.created.length} 个认领账号`
        + `（状态 ${result.status}）`,
      );
    }
    return result;
  }

  /** 认领结算口径（无持久化时的本地推导，与 `ReplicationAttemptService.settleClaims` 保持一致） */
  private deriveClaimStatus(
    claimed: string[],
    baselineCount: number,
    desiredCount: number,
  ): ReplicationAttemptStatus {
    if (claimed.length <= baselineCount) return 'claim_timeout';
    return claimed.length >= desiredCount ? 'succeeded' : 'partial_success';
  }

  /**
   * 前置能力校验（策略 B fail-closed 的判定表）。
   *
   * 为什么在调用 `relay()` 之前先查一遍：中继内部也会判定同样的事，但那里的失败
   * 会先消耗一次「尝试」计数；这里把「确定性不可用」（开关未开、目标群未配、源锚点缺失）
   * 提前分流，使告警里的失败数只反映真正的执行失败。
   */
  private evaluateRelayBlockers(input: {
    relayAvailable: boolean;
    relayEnabled: boolean;
    targetChatId: string;
    anchorChatId: string;
    anchorMessageId: string;
  }): { status: ReplicationAttemptStatus; reason: UserRelayFailureReason; summary: string } | null {
    if (!input.relayAvailable || !input.relayEnabled) {
      return {
        status: 'blocked_not_configured',
        reason: 'not_configured',
        summary: 'TELEGRAM_USER_RELAY_ENABLED 未开启：策略 B 不可用，需配置后重启（构造期读取）',
      };
    }
    if (!input.anchorChatId || !input.anchorMessageId) {
      return {
        status: 'blocked_source_anchor',
        reason: 'source_missing',
        summary: '缺少可中继的源消息锚点（chatId + messageId）：源群必须对用户账号可读',
      };
    }
    if (!input.targetChatId) {
      return {
        status: 'blocked_target_chat',
        reason: 'target_missing',
        summary: '没有启用中的镜像规则目标群（副本可见群），中继没有可写入的目标位置',
      };
    }
    return null;
  }

  /** 把前置阻塞/中继失败收口为轮次终态（观测缺失时静默跳过，绝不阻塞主链路） */
  private async settleBlockedRound(
    begin: BeginRoundResult | null,
    status: ReplicationAttemptStatus,
    reason: UserRelayFailureReason,
    summary: string,
    desiredCount: number,
    readyCount: number,
  ): Promise<void> {
    const attemptId = begin?.attempt?.id;
    if (!attemptId || !this.attempts) return;
    await this.attempts.finishBlocked(attemptId, {
      status,
      failureReason: reason,
      failureSummary: summary,
      missingCount: Math.max(0, desiredCount - readyCount),
    });
  }

  /**
   * 等待用户账号中继后的「入站认领」（有界轮询，绝不无限等）。
   *
   * 中继是服务端转发，群内各 Bot 通过**长轮询**收到 update 后才登记自己的 `file_id`；
   * 这个延迟取决于轮询周期与网络，典型在秒级。这里按固定间隔复查 ready 账号集合，
   * 达到期望数或超出窗口即返回当前集合。
   *
   * 为什么必须有界：`ensureCopies` 在下载期被懒触发（`scheduleReplication`），
   * 若在这里长时间阻塞，会把「首个字节」拖到复制之后，违背「非阻断懒扩散」的约束。
   * 窗口之外由下一轮懒扩散继续补齐（扩散是持续过程，不追求单次到齐）。
   */
  private async waitForRelayClaims(
    ownerType: TelegramCopyOwnerType,
    ownerId: string,
    baselineCount: number,
    desiredCount: number,
  ): Promise<string[]> {
    const deadline = Date.now() + RELAY_CLAIM_WAIT_MS;
    let accounts = await this.readyAccountIds(ownerType, ownerId);
    while (accounts.length <= baselineCount && accounts.length < desiredCount && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, RELAY_CLAIM_POLL_MS));
      accounts = await this.readyAccountIds(ownerType, ownerId);
    }
    return accounts;
  }

  /** 日志用的短前缀（避免把完整 file_unique_id 写进日志） */
  private preview(value: string): string {
    const trimmed = (value || '').trim();
    return trimmed.length <= 16 ? trimmed : `${trimmed.slice(0, 16)}…`;
  }
}
