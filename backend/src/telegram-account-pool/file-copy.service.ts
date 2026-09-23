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
   * @param desiredCount 期望的副本总数（例如 min(账号数, C / 每账号在飞上限)）
   */
  async planTargets(
    ownerType: TelegramCopyOwnerType,
    ownerId: string,
    desiredCount: number,
  ): Promise<string[]> {
    const held = new Set(await this.readyAccountIds(ownerType, ownerId));
    // 只把「已配置存储 Chat」的账号作为扩散目标：没有存储 Chat 的账号上传必然失败，
    // 让它进入候选只会产生必败上传并放大上游请求（表现为「扩散持续失败」）。
    const poolIds = this.pool.storageAccountIds();
    const need = Math.max(0, desiredCount - held.size);
    if (need === 0) return [];
    const candidates = poolIds.filter((id) => !held.has(id));
    const picked: string[] = [];
    // 逐个挑选：每次选择都会把已选账号计入在飞，天然避免重复选中同一账号
    for (let index = 0; index < Math.min(need, candidates.length); index += 1) {
      const selection = this.pool.select(candidates.filter((id) => !picked.includes(id)));
      if (!selection) break;
      picked.push(selection.accountId);
    }
    return picked;
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

    const task = this.doEnsureCopy(params).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  private async doEnsureCopy(params: {
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
    const sourceCopy = params.sourceAccountId
      ? sources.find((item) => item.accountId === params.sourceAccountId) ?? null
      : null;
    const fallbackSelection = this.pool.select(sources.map((item) => item.accountId));
    const chosenSource = sourceCopy
      ?? (fallbackSelection ? sources.find((item) => item.accountId === fallbackSelection.accountId) ?? null : null);
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

    const targets = (await this.planTargets(params.ownerType, params.ownerId, params.desiredCount))
      .slice(0, MAX_REPLICATION_TARGETS);
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
