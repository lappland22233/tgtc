import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { File } from '../common/entities/file.entity';
import {
  TelegramCopyOwnerType,
  TelegramCopySource,
  TelegramFileCopy,
} from '../common/entities/telegram-file-copy.entity';
import { TelegramAccountClientService, TelegramAccountError } from './telegram-account-client.service';
import { TelegramAccountPoolService } from './telegram-account-pool.service';
import { UserRelayService } from './user-relay.service';

/** 单次请求最多为几个目标账号做副本扩散（防止一次请求打爆上传带宽） */
const MAX_REPLICATION_TARGETS = 4;

/**
 * 目标 claim 有效期（毫秒）。
 *
 * 为什么需要：`planTargets()` 只是「选号」，`pool.select()` 不占用任何在飞额度，
 * 因此并发请求会各自选出同一批目标并重复排队上传（互相看不到对方的计划）。
 * claim 表在「选中目标 → 复制结束」之间占位，让跨请求的目标选择互斥；
 * 复制结束后立即释放，失败仍可在下一轮重试。
 */
const REPLICATION_CLAIM_TTL_MS = 5 * 60 * 1000;
/** claim 表清理阈值（超过该规模才做一次过期清理，避免每轮遍历） */
const REPLICATION_CLAIM_PRUNE_THRESHOLD = 1024;
/**
 * 跨逻辑文件的复制并发上限。
 *
 * 每个逻辑文件内部保持串行；跨文件若不限制，多个文件的扩散会同时向 Telegram
 * 发起上传，与下载回源争抢账号在飞额度与出网带宽（复制只能是下载的「副产品」）。
 */
const MAX_GLOBAL_REPLICATION_CONCURRENCY = 2;
/** 副本覆盖率审计单次扫描的逻辑文件分组上限（管理端接口不得把全表拉进内存） */
export const REPLICATION_COVERAGE_MAX_GROUPS = 5000;

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
  created: string[];
  skipped: string[];
  failed: Array<{ accountId: string; error: string }>;
  /** 是否使用了用户账号中继（策略 B） */
  relayed: boolean;
}

/**
 * 文件副本服务：多账号回源的「共享层」。
 *
 * 两条共享策略（对应产品方案 A + B）：
 * - **A. 副本扩散（默认，纯 bot）**：任取一个已有副本作为源，把字节用目标账号重新上传，
 *   目标账号由此获得**自己的** `file_id`。代价是上传流量 ×(K−1)，但无外部依赖。
 * - **B. 用户账号中继（可选）**：由 MTProto 用户账号把源消息转发进群，群里各 bot（管理员）
 *   各自收到更新 → 由入站链路登记自己的副本。只需一次转发流量，但依赖 user session。
 *
 * 并发安全：`(ownerType, ownerId, accountId)` 唯一 + 进程内 in-flight 去重，
 * 保证同一文件同一账号不会被并发重复复制。
 */
@Injectable()
export class FileCopyService {
  private readonly logger = new Logger(FileCopyService.name);
  /** 进程内复制去重：key=`owner:account` → Promise */
  private readonly inflight = new Map<string, Promise<TelegramFileCopy | null>>();
  /** 同一逻辑文件的批量扩散 single-flight：key=`ownerType:ownerId` → Promise（并发请求共享） */
  private readonly ensureCopiesInflight = new Map<string, Promise<ReplicationResult>>();
  /** 目标 claim：key=`ownerType:ownerId:accountId` → 到期时间戳（跨请求互斥同一目标） */
  private readonly targetClaims = new Map<string, number>();
  /** 跨逻辑文件复制并发闸门 */
  private activeReplications = 0;
  private readonly replicationWaiters: Array<() => void> = [];

  constructor(
    @InjectRepository(TelegramFileCopy)
    private readonly repo: Repository<TelegramFileCopy>,
    private readonly pool: TelegramAccountPoolService,
    private readonly client: TelegramAccountClientService,
    @Optional() @Inject(UserRelayService) private readonly relay: UserRelayService | null,
    /**
     * 站内逻辑文件仓库（入站副本桥接用）。
     *
     * 用 `@Optional()`：大量单测以 `new FileCopyService(repo, pool, client, relay)` 直接构造，
     * 桥接是可选增强能力，缺失时应静默跳过而非抛错。
     */
    @Optional() @InjectRepository(File) private readonly files: Repository<File> | null = null,
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
   */
  async findByAnchor(chatId: string, messageId: string): Promise<TelegramFileCopy | null> {
    return this.repo.findOne({ where: { chatId, messageId } });
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
  }): Promise<{ bridged: boolean; matchedFileIds: string[] }> {
    const result: { bridged: boolean; matchedFileIds: string[] } = { bridged: false, matchedFileIds: [] };
    const fileUniqueId = (params.fileUniqueId || '').trim();
    if (!fileUniqueId || !this.files) return result;

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
          source: 'inbound',
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

  /** 登记/更新副本（同 owner+account 覆盖，重投幂等） */
  async upsertReady(input: CopyRecordInput): Promise<TelegramFileCopy> {
    const existing = await this.find(input.ownerType, input.ownerId, input.accountId);
    if (existing) {
      existing.telegramFileId = input.telegramFileId;
      existing.chatId = input.chatId ?? existing.chatId;
      existing.messageId = input.messageId ?? existing.messageId;
      existing.fileSize = input.fileSize != null ? String(input.fileSize) : existing.fileSize;
      existing.source = input.source;
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

  async markFailed(
    ownerType: TelegramCopyOwnerType,
    ownerId: string,
    accountId: string,
    error: string,
  ): Promise<void> {
    const existing = await this.find(ownerType, ownerId, accountId);
    if (!existing) return;
    existing.status = 'failed';
    existing.lastError = error.slice(0, 500);
    await this.repo.save(existing);
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
   * 选出「应当持有副本」的目标账号：优先当前吞吐最优、且尚未持有副本的账号。
   *
   * 契约说明（修正历史注释）：`pool.select()` **不会**增加任何在飞额度，
   * 原实现只是靠单次调用内的 `picked` 集合避免重复选中；跨请求的重复排队由
   * 目标 claim 表（`targetClaims`）与 `ensureCopies` 的 single-flight 共同保证。
   *
   * 目标资格（全部满足，任一不满足即排除并可通过 `evaluateTargetEligibility` 解释）：
   * enabled、已配置存储 Chat（无存储 Chat 的上传必失败）、未处于冷却、
   * 在飞未达 `maxInflight`、不等于源账号、当前无同文件 claim、尚未持有 ready 副本。
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

    const now = Date.now();
    const candidates = this.eligibleTargets(ownerType, ownerId, held, sourceAccountId, now);
    const picked: string[] = [];
    for (let index = 0; index < Math.min(need, candidates.length); index += 1) {
      const selection = this.pool.select(candidates.filter((id) => !picked.includes(id)));
      if (!selection) break;
      picked.push(selection.accountId);
      // 选中即占位：其它请求在同一窗口内不会再选到同一目标
      this.claimTarget(ownerType, ownerId, selection.accountId, now);
    }
    return picked;
  }

  /**
   * 可承载副本的候选账号（含排除原因）。
   *
   * 与「下载选号」共用同一份账号运行态快照：冷却/在飞上限必须在这里被尊重，
   * 否则扩散会绕开账号池的容量控制，把某账号压垮而不自知。
   */
  evaluateTargetEligibility(
    ownerType: TelegramCopyOwnerType,
    ownerId: string,
    heldAccountIds: string[],
    sourceAccountId?: string,
    nowMs: number = Date.now(),
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
      if (this.isClaimed(ownerType, ownerId, account.id, nowMs)) reasons.push('已有扩散任务排队中');
      return { accountId: account.id, eligible: reasons.length === 0, reasons };
    });
  }

  /** 过滤出可承载副本的候选账号 id（顺序沿用账号池快照顺序） */
  private eligibleTargets(
    ownerType: TelegramCopyOwnerType,
    ownerId: string,
    held: Set<string>,
    sourceAccountId: string | undefined,
    nowMs: number,
  ): string[] {
    return this.evaluateTargetEligibility(ownerType, ownerId, Array.from(held), sourceAccountId, nowMs)
      .filter((item) => item.eligible)
      .map((item) => item.accountId);
  }

  private claimKey(ownerType: TelegramCopyOwnerType, ownerId: string, accountId: string): string {
    return `${ownerType}:${ownerId}:${accountId}`;
  }

  private isClaimed(
    ownerType: TelegramCopyOwnerType,
    ownerId: string,
    accountId: string,
    nowMs: number,
  ): boolean {
    const key = this.claimKey(ownerType, ownerId, accountId);
    const until = this.targetClaims.get(key);
    if (until === undefined) return false;
    if (until <= nowMs) {
      this.targetClaims.delete(key);
      return false;
    }
    return true;
  }

  private claimTarget(
    ownerType: TelegramCopyOwnerType,
    ownerId: string,
    accountId: string,
    nowMs: number,
  ): void {
    this.pruneClaims(nowMs);
    this.targetClaims.set(this.claimKey(ownerType, ownerId, accountId), nowMs + REPLICATION_CLAIM_TTL_MS);
  }

  /** 复制结束（成功/失败/异常）后释放 claim，让失败目标能在下一轮重试 */
  private releaseClaim(ownerType: TelegramCopyOwnerType, ownerId: string, accountId: string): void {
    this.targetClaims.delete(this.claimKey(ownerType, ownerId, accountId));
  }

  /** 清理过期 claim（仅在表规模较大时遍历，避免每轮扫描） */
  private pruneClaims(nowMs: number): void {
    if (this.targetClaims.size < REPLICATION_CLAIM_PRUNE_THRESHOLD) return;
    for (const [key, until] of this.targetClaims) {
      if (until <= nowMs) this.targetClaims.delete(key);
    }
  }

  /** 获取跨文件复制槽位（超出并发上限则排队等待） */
  private async acquireReplicationSlot(): Promise<void> {
    if (this.activeReplications < MAX_GLOBAL_REPLICATION_CONCURRENCY) {
      this.activeReplications += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.replicationWaiters.push(resolve);
    });
    this.activeReplications += 1;
  }

  /** 归还跨文件复制槽位并唤醒下一个等待者 */
  private releaseReplicationSlot(): void {
    this.activeReplications = Math.max(0, this.activeReplications - 1);
    const next = this.replicationWaiters.shift();
    next?.();
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
   * 确保指定账号持有文件副本（策略 A；失败自动记录并交由账号池冷却）。
   * `source` 可指定复制来源（例如刚收到文件的账号）；不指定则由账号池从现有副本中挑最优者。
   */
  async ensureCopy(
    params: {
      ownerType: TelegramCopyOwnerType;
      ownerId: string;
      targetAccountId: string;
      fileName: string;
      expectedSize: number;
      sourceAccountId?: string;
    },
  ): Promise<TelegramFileCopy | null> {
    const key = `${params.ownerType}:${params.ownerId}:${params.targetAccountId}`;
    const running = this.inflight.get(key);
    if (running) return running;

    const task = this.doEnsureCopy(params).finally(() => {
      this.inflight.delete(key);
      // 无论成功与失败都释放 claim：失败必须能在下一轮（或稍后）重试同一目标
      this.releaseClaim(params.ownerType, params.ownerId, params.targetAccountId);
    });
    this.inflight.set(key, task);
    return task;
  }

  /** 复制并发闸门包装：跨逻辑文件最多 `MAX_GLOBAL_REPLICATION_CONCURRENCY` 个复制同时进行 */
  private async doEnsureCopy(params: {
    ownerType: TelegramCopyOwnerType;
    ownerId: string;
    targetAccountId: string;
    fileName: string;
    expectedSize: number;
    sourceAccountId?: string;
  }): Promise<TelegramFileCopy | null> {
    await this.acquireReplicationSlot();
    try {
      return await this.performCopy(params);
    } finally {
      this.releaseReplicationSlot();
    }
  }

  /** 实际复制：源账号取流 → 目标账号重新上传 → 登记 ready 副本（失败留痕并交账号池冷却） */
  private async performCopy(params: {
    ownerType: TelegramCopyOwnerType;
    ownerId: string;
    targetAccountId: string;
    fileName: string;
    expectedSize: number;
    sourceAccountId?: string;
  }): Promise<TelegramFileCopy | null> {
    const target = this.pool.getConfig(params.targetAccountId);
    if (!target) {
      this.logger.warn(`副本扩散目标账号不存在：${params.targetAccountId}`);
      return null;
    }
    // 无存储 Chat 的账号无法承载副本（上传必失败），直接跳过并留痕
    if (!target.chatId) {
      this.logger.warn(`副本扩散目标账号未配置存储 Chat，已跳过：${params.targetAccountId}`);
      return null;
    }
    // 1) 选源：优先调用方指定，否则从现有 ready 副本里按加权挑（读侧也做负载分散）
    const sources = await this.listReady(params.ownerType, params.ownerId);
    // 目标已持有 ready 副本 → 无可扩散内容（幂等：不重复上传、不消耗上游额度）
    const alreadyHeld = sources.find((item) => item.accountId === params.targetAccountId);
    if (alreadyHeld) {
      this.logger.debug(`副本扩散目标 ${params.targetAccountId} 已持有 ready 副本，跳过重复上传`);
      return alreadyHeld;
    }
    // 源账号与目标账号不能相同：直接把 A 的副本「复制给 A」没有意义
    const sourceCopy = params.sourceAccountId && params.sourceAccountId !== params.targetAccountId
      ? sources.find((item) => item.accountId === params.sourceAccountId) ?? null
      : null;
    const sourceCandidates = sources.filter((item) => item.accountId !== params.targetAccountId);
    const fallbackSelection = this.pool.select(sourceCandidates.map((item) => item.accountId));
    const chosenSource = sourceCopy
      ?? (fallbackSelection ? sourceCandidates.find((item) => item.accountId === fallbackSelection.accountId) ?? null : null);
    if (!chosenSource) {
      this.pool.bumpCounter('replicationsFailed');
      this.logger.warn(
        `副本扩散缺少可用源（${params.ownerType}:${params.ownerId}）——请先登记至少一个 inbound 副本`,
      );
      return null;
    }
    const sourceAccount = this.pool.getConfig(chosenSource.accountId);
    if (!sourceAccount) return null;

    const size = Number(chosenSource.fileSize ?? params.expectedSize);
    if (!Number.isSafeInteger(size) || size <= 0) {
      this.logger.warn(`副本扩散缺少有效大小（${params.ownerType}:${params.ownerId}）`);
      return null;
    }

    // 2) 源账号取流（计入在飞；结束回报采样 → 带宽 EWMA 会随真实传输更新）
    if (!this.pool.beginAttempt(sourceAccount.id)) return null;
    let session: Awaited<ReturnType<TelegramAccountClientService['openRealtimeStream']>>;
    try {
      session = await this.client.openRealtimeStream(sourceAccount.id, sourceAccount.token, chosenSource.telegramFileId, size);
    } catch (error) {
      this.pool.releaseAttempt(sourceAccount.id);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`副本扩散取源失败（${sourceAccount.id}）：${message}`);
      return null;
    }
    // 源流采样必须**幂等**：`close` 与 `error` 都可能触发（例如先 error 后 close），
    // 重复回报会二次释放在飞额度、翻倍累计请求/失败并放大冷却，污染账号画像、
    // 削弱「每账号在飞上限」的限流保护。
    let sourceSettled = false;
    const settleSource = (): void => {
      if (sourceSettled) return;
      sourceSettled = true;
      this.pool.finishAttempt(sourceAccount.id, session.sample());
    };
    session.stream.once('close', settleSource);
    session.stream.once('error', settleSource);

    // 3) 目标账号上传（同一时刻只占一个在飞额度）
    if (!this.pool.beginAttempt(target.id)) {
      // 只销毁源流，并由 settleSource 释放且仅释放一次额度
      // （destroy 触发的 close 会再次回调同一守卫，不会重复释放）
      session.stream.destroy();
      settleSource();
      return null;
    }
    try {
      const uploaded = await this.client.sendDocumentStream(
        target.id,
        target.token,
        target.chatId,
        session.stream,
        params.fileName,
        size,
      );
      this.pool.finishAttempt(target.id, uploaded.sample);
      const copy = await this.upsertReady({
        ownerType: params.ownerType,
        ownerId: params.ownerId,
        accountId: target.id,
        telegramFileId: uploaded.fileId,
        chatId: uploaded.chatId,
        messageId: uploaded.messageId,
        fileSize: uploaded.fileSize,
        source: 'replicated',
      });
      this.pool.bumpCounter('replicationsOk');
      this.logger.log(
        `副本扩散成功：${params.ownerType}:${params.ownerId} → 账号 ${target.id}（源 ${sourceAccount.id}）`,
      );
      return copy;
    } catch (error) {
      const accountError = error instanceof TelegramAccountError ? error : null;
      this.pool.finishAttempt(target.id, {
        ok: false,
        failureKind: accountError?.kind ?? 'other',
        status: accountError?.status,
        retryAfterSeconds: accountError?.retryAfterSeconds,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.pool.bumpCounter('replicationsFailed');
      await this.markFailed(params.ownerType, params.ownerId, target.id, error instanceof Error ? error.message : String(error));
      return null;
    }
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
   * 批量确保副本：给 planTargets 选出的账号逐个扩散（串行，避免抢占下载带宽）。
   * 若配置了用户账号中继（策略 B），优先尝试中继（省一次上传流量）。
   */
  async ensureCopies(params: {
    ownerType: TelegramCopyOwnerType;
    ownerId: string;
    fileName: string;
    expectedSize: number;
    desiredCount: number;
    sourceAccountId?: string;
  }): Promise<ReplicationResult> {
    const key = `${params.ownerType}:${params.ownerId}`;
    const running = this.ensureCopiesInflight.get(key);
    if (running) return running;

    const task = this.doEnsureCopies(params).finally(() => this.ensureCopiesInflight.delete(key));
    this.ensureCopiesInflight.set(key, task);
    return task;
  }

  /**
   * 实际执行批量扩散（同一逻辑文件内**串行**，跨文件由复制并发闸门限制）。
   *
   * single-flight 语义：并发调用共享同一轮结果；若后到者需要更多目标，
   * 会由下一轮懒扩散补齐（扩散是持续过程，不追求单次到齐）。
   */
  private async doEnsureCopies(params: {
    ownerType: TelegramCopyOwnerType;
    ownerId: string;
    fileName: string;
    expectedSize: number;
    desiredCount: number;
    sourceAccountId?: string;
  }): Promise<ReplicationResult> {
    const result: ReplicationResult = { created: [], skipped: [], failed: [], relayed: false };

    const held = await this.readyAccountIds(params.ownerType, params.ownerId);
    if (held.length >= params.desiredCount) {
      result.skipped = held;
      return result;
    }

    // 策略 B：用户账号中继（一次转发 → 各 bot 由入站链路自行登记副本）
    const relayed = await this.tryRelayViaUser(params.ownerType, params.ownerId, params.sourceAccountId);
    if (relayed.ok) {
      result.relayed = true;
      this.logger.log(`已通过用户账号中继文件（${params.ownerType}:${params.ownerId}），等待各账号入站登记副本`);
      return result;
    }
    this.logger.log(
      `用户账号中继未生效（${params.ownerType}:${params.ownerId} / ${relayed.reason ?? 'unknown'}），`
      + '回退逐账号副本扩散',
    );

    // 目标数量在规划阶段就收敛到单次上限：避免为「不会被处理」的目标留下 claim
    // （claim 要等 5min TTL 或进程重启才消失，会让这些账号在窗口内无法被其它请求选中）
    const targets = await this.planTargets(
      params.ownerType,
      params.ownerId,
      Math.min(params.desiredCount, MAX_REPLICATION_TARGETS),
      params.sourceAccountId,
    );
    for (const accountId of targets) {
      const copy = await this.ensureCopy({
        ownerType: params.ownerType,
        ownerId: params.ownerId,
        targetAccountId: accountId,
        fileName: params.fileName,
        expectedSize: params.expectedSize,
        sourceAccountId: params.sourceAccountId,
      });
      if (copy) result.created.push(accountId);
      else result.failed.push({ accountId, error: 'replication_failed_or_unavailable' });
    }
    return result;
  }

  /** 策略 B：尝试用用户账号把源消息转发进群（未配置时返回可诊断原因，绝不伪装成功） */
  private async tryRelayViaUser(
    ownerType: TelegramCopyOwnerType,
    ownerId: string,
    sourceAccountId?: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    // 只看「开关是否打开」，**不用** isConfigured() 提前短路：
    // 后者把「客户端不可用」也折叠成 not_configured，会让 relay() 里的
    // user_relay_unavailable 分支永远不可达 → 该类失败不进计数、不进告警（静默盲区）。
    // 这里把「是否可用」交给 relay() 判定，由它统一计数与给出可诊断原因。
    if (!this.relay || !this.relay.isEnabledByConfig()) {
      return { ok: false, reason: 'user_relay_not_configured' };
    }
    const sources = await this.listReady(ownerType, ownerId);
    const anchor = sourceAccountId
      ? sources.find((item) => item.accountId === sourceAccountId)
      : sources[0];
    if (!anchor?.chatId || !anchor.messageId) {
      return { ok: false, reason: 'anchor_message_missing' };
    }
    // 目标群由中继自行解析：优先启用中镜像规则的备份群，其次 TELEGRAM_ARCHIVE_CHAT_ID
    const targetChatId = await this.relay.resolveTargetChatId();
    return this.relay.relay({
      sourceChatId: anchor.chatId,
      sourceMessageId: anchor.messageId,
      targetChatId,
      // 中继同样遵守「源账号优先」：用记录里的源账号 file_id 对应的那条消息作锚点
      idempotencyKey: `copy:${ownerType}:${ownerId}`,
    });
  }

  /** 日志用的短前缀（避免把完整 file_unique_id 写进日志） */
  private preview(value: string): string {
    const trimmed = (value || '').trim();
    return trimmed.length <= 16 ? trimmed : `${trimmed.slice(0, 16)}…`;
  }
}
