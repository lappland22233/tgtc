import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../common/services/audit.service';
import { File } from '../common/entities/file.entity';
import { TelegramFileCopy } from '../common/entities/telegram-file-copy.entity';
import { TelegramMirrorTask } from '../common/entities/telegram-mirror-task.entity';
import { FileCopyService } from '../telegram-account-pool/file-copy.service';
import { TelegramMirrorConfigService } from './telegram-mirror-config.service';
import { TelegramMirrorTriggerService } from './telegram-mirror-trigger.service';
import { TelegramAccountFeatureService } from '../telegram-accounts/telegram-account-feature.service';
// 5c：锚点可用性与源解析共用同一口径（见 isUsableSourceCopyAnchor 的「同归属 + 当前版本」说明）
import { isUsableSourceCopyAnchor } from './telegram-mirror-source.service';

/** 单批扫描条数与批间隔（限速：避免补偿任务抢占正常上传/下载的带宽与队列） */
const BACKFILL_BATCH_SIZE = 20;
const BACKFILL_BATCH_DELAY_MS = 1_000;
/** 单次补偿最多处理的文件数上限（防止一次误操作把整个历史库塞进队列） */
const BACKFILL_MAX_LIMIT = 5_000;

export type BackfillStatus = 'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';

export interface BackfillJobState {
  status: BackfillStatus;
  mode: 'dry-run' | 'apply';
  limit: number;
  scanned: number;
  queued: number;
  skipped: number;
  /** dry-run 模式下将入队的样本（最多 20 条），便于管理员评估影响面 */
  sample: string[];
  /** 可恢复性分类（dry-run 与实跑都会累计，便于管理员判断影响面） */
  classification: {
    /** 可执行：主记录或同归属副本锚点完整，将按当前版本建单 */
    executable: number;
    /** 缺源锚点：无法定位源消息，跳过（不建单） */
    missingAnchor: number;
    /** 已有当前版本任务，跳过 */
    covered: number;
    /** 存在旧版本任务（版本不符），将按当前版本补建 */
    staleVersion: number;
  };
  /** 缺源锚点样本（最多 20 条站内文件 id，便于人工核查） */
  missingAnchorSample: string[];
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  lastError: string | null;
  /** 当前批次游标（file.createdAt + id），仅用于进度展示 */
  cursor: string | null;
}

/**
 * 历史文件补偿镜像（阶段 3）。
 *
 * 为什么必须显式限速与可暂停：
 * - 补偿会为每个文件补齐「主群搬运 + userbot 中继到各镜像群」的任务，历史库全量回填
 *   会突然产生大量 Telegram 侧 API 调用（**不产生文件字节流量**：全程服务端转发）；
 * - 补偿**不改变**现有下载链接，也不跨账号复用 `file_id`；
 * - 任务全部走同一个幂等键 `(ruleId, ownerType, ownerId, sourceVersion)`，
 *   重复运行不会产生重复备份（可安全重跑）。
 *
 * 分类口径（dry-run 与实跑都会累计，便于管理员判断影响面）：
 * - `executable`：主记录（telegramChatId + telegramMessageId）或**同归属** ready 副本
 *   锚点完整（口径与 `isUsableSourceCopyAnchor` 一致），将按当前版本建单；
 * - `missingAnchor`：主记录与副本都无法定位源消息，跳过（不建单，记样本供人工核查）；
 * - `covered`：已有当前版本的**全部**启用规则任务，跳过；
 * - `staleVersion`：只存在旧版本任务（版本不符），将按当前版本补建（幂等键保证不重复）。
 *
 * 为什么只分类不做扩散：本服务只负责「建单」——真正的中继执行由镜像任务队列
 * （主群 → userbot → 各镜像群）承担。分类仅用于让管理员判断影响面与人工核查缺口，
 * 不引入任何新的执行路径（否则会与任务队列重复覆盖同一动作，重蹈策略 A 覆辙）。
 *
 * 边界：临时补跑只处理「站内文件」；Bot 私聊入站历史消息无法在不重新拉取
 * Telegram 更新的前提下可靠重建源消息定位，故不纳入本次补偿（会明确跳过并计数）。
 */
@Injectable()
export class TelegramMirrorBackfillService {
  private readonly logger = new Logger(TelegramMirrorBackfillService.name);
  private state: BackfillJobState = createIdleState();
  private pauseRequested = false;
  private cancelRequested = false;

  constructor(
    @InjectRepository(File)
    private readonly files: Repository<File>,
    @InjectRepository(TelegramMirrorTask)
    private readonly tasks: Repository<TelegramMirrorTask>,
    private readonly config: TelegramMirrorConfigService,
    private readonly trigger: TelegramMirrorTriggerService,
    private readonly feature: TelegramAccountFeatureService,
    private readonly audit: AuditService,
    // 5c：批处理取「同归属 ready 副本」用于锚点判定（TelegramAccountPoolModule 已导出）
    private readonly fileCopies: FileCopyService,
  ) {}

  status(): BackfillJobState {
    return {
      ...this.state,
      sample: [...this.state.sample],
      // 快照必须拷贝：分类与样本是调用方直接展示的对象，泄漏内部引用会被后续批次改写
      classification: { ...this.state.classification },
      missingAnchorSample: [...this.state.missingAnchorSample],
    };
  }

  /**
   * 启动补偿（`dry-run` 只统计不入队，`apply` 真正入队）。
   * 幂等：重复运行时已存在任务的文件会被跳过。
   */
  async start(input: { mode: 'dry-run' | 'apply'; limit?: number }, actorId: string): Promise<BackfillJobState> {
    if (this.state.status === 'running') {
      throw new BadRequestException('已有补偿任务在运行中，请先暂停或取消');
    }
    if (!(await this.feature.isMirrorEnabled())) {
      throw new BadRequestException('镜像功能开关未开启，无法执行历史补偿');
    }
    const rules = await this.config.listEnabledRules();
    if (rules.length === 0) {
      throw new BadRequestException('没有启用中的镜像规则（且未通过权限测试），无法执行历史补偿');
    }

    const limit = Math.min(Math.max(Number(input.limit) || 200, 1), BACKFILL_MAX_LIMIT);
    this.pauseRequested = false;
    this.cancelRequested = false;
    this.state = {
      status: 'running',
      mode: input.mode,
      limit,
      scanned: 0,
      queued: 0,
      skipped: 0,
      sample: [],
      classification: { executable: 0, missingAnchor: 0, covered: 0, staleVersion: 0 },
      missingAnchorSample: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      lastError: null,
      cursor: null,
    };

    this.audit.log({
      action: 'telegram_mirror_backfill_started',
      userId: actorId,
      resourceType: 'telegram_mirror_backfill',
      resourceId: 'backfill',
      metadata: { mode: input.mode, limit, ruleIds: rules.map((item) => item.id) },
    });

    // 后台执行：接口立即返回 job 状态，进度由 GET 轮询
    void this.run().catch((error: unknown) => {
      this.state.status = 'failed';
      this.state.lastError = error instanceof Error ? error.message : String(error);
      this.state.updatedAt = new Date().toISOString();
      this.state.finishedAt = this.state.updatedAt;
      this.logger.error(`历史补偿失败：${this.state.lastError}`);
    });
    return this.status();
  }

  pause(): BackfillJobState {
    if (this.state.status !== 'running') throw new BadRequestException('当前没有正在运行的补偿任务');
    this.pauseRequested = true;
    return this.status();
  }

  resume(actorId: string): BackfillJobState {
    if (this.state.status !== 'paused') throw new BadRequestException('当前没有已暂停的补偿任务');
    this.pauseRequested = false;
    this.state.status = 'running';
    this.state.updatedAt = new Date().toISOString();
    this.audit.log({
      action: 'telegram_mirror_backfill_resumed',
      userId: actorId,
      resourceType: 'telegram_mirror_backfill',
      resourceId: 'backfill',
      metadata: { resumed: true, scanned: this.state.scanned, queued: this.state.queued },
    });
    void this.run().catch((error: unknown) => {
      this.state.status = 'failed';
      this.state.lastError = error instanceof Error ? error.message : String(error);
    });
    return this.status();
  }

  cancel(): BackfillJobState {
    if (this.state.status !== 'running' && this.state.status !== 'paused') {
      throw new BadRequestException('当前没有可取消的补偿任务');
    }
    this.cancelRequested = true;
    this.state.status = 'cancelled';
    this.state.updatedAt = new Date().toISOString();
    this.state.finishedAt = this.state.updatedAt;
    return this.status();
  }

  /**
   * 补偿主循环：按 `createdAt DESC, id DESC` 游标分页扫描（避免深分页性能陷阱），
   * 每批之间主动让出 1s，保证不抢占正常链路带宽。
   *
   * 每条启用规则各建一条任务（一个镜像群一条）；一个文件只有在**全部**启用规则
   * 都已有任务时才算「已补偿」，否则补齐缺口（建单幂等，重复运行安全）。
   */
  private async run(): Promise<void> {
    const enabledRuleIds = (await this.config.listEnabledRules()).map((rule) => rule.id);
    if (enabledRuleIds.length === 0) {
      this.state.status = 'completed';
      this.state.finishedAt = new Date().toISOString();
      this.state.updatedAt = this.state.finishedAt;
      return;
    }
    let cursor: { createdAt: Date; id: string } | null = null;

    while (this.state.scanned < this.state.limit) {
      if (this.cancelRequested) {
        this.state.status = 'cancelled';
        this.state.finishedAt = new Date().toISOString();
        return;
      }
      if (this.pauseRequested) {
        this.state.status = 'paused';
        this.state.updatedAt = new Date().toISOString();
        return;
      }

      const remaining = this.state.limit - this.state.scanned;
      const batchSize = Math.min(BACKFILL_BATCH_SIZE, remaining);
      const builder = this.files.createQueryBuilder('file')
        .where('file.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('file.status = :status', { status: 'ready' })
        .andWhere('file.uploadStage = :stage', { stage: 'committed' })
        .orderBy('file.createdAt', 'DESC')
        .addOrderBy('file.id', 'DESC')
        .take(batchSize);

      if (cursor) {
        builder.andWhere(
          '(file.createdAt < :cursorCreatedAt OR (file.createdAt = :cursorCreatedAt AND file.id < :cursorId))',
          { cursorCreatedAt: cursor.createdAt, cursorId: cursor.id },
        );
      }

      const batch = await builder.getMany();
      if (batch.length === 0) {
        this.state.status = 'completed';
        this.state.finishedAt = new Date().toISOString();
        this.state.updatedAt = this.state.finishedAt;
        this.logger.log(
          `历史补偿完成：扫描 ${this.state.scanned}，入队 ${this.state.queued}，跳过 ${this.state.skipped}`,
        );
        return;
      }

      // 5c 批处理改造（避免逐文件 N+1）：
      // - 每批**一次**取回「本批文件的 ready 副本」（锚点判定用）；
      // - 每批**一条**聚合查询取回「本批文件的任务覆盖情况」（替代逐文件 count）。
      const batchIds = batch.map((file) => file.id);
      const copiesByOwner = await this.fileCopies.listReadyByOwnerIds('file', batchIds);
      const coverageByOwner = await this.loadBatchTaskCoverage(batchIds, enabledRuleIds);

      for (const file of batch) {
        this.state.scanned += 1;
        const last = batch[batch.length - 1];
        cursor = { createdAt: new Date(last.createdAt), id: last.id };
        this.state.cursor = `${new Date(last.createdAt).toISOString()}/${last.id}`;

        const sourceVersion = Number(file.uploadVersion) || 1;
        const coverage = coverageByOwner.get(file.id);
        const currentVersionTasks = coverage?.byVersion.get(sourceVersion) ?? 0;
        const anyVersionTasks = coverage?.anyVersion ?? 0;

        // 分类（dry-run 与实跑都累计）：当前版本任务齐 → covered；
        // 只有旧版本任务 → staleVersion；否则按锚点判定 executable / missingAnchor。
        let anchorCopy: TelegramFileCopy | null = null;
        let category: keyof BackfillJobState['classification'];
        if (currentVersionTasks >= enabledRuleIds.length) {
          category = 'covered';
        } else if (anyVersionTasks > 0) {
          category = 'staleVersion';
        } else {
          const mainAnchorComplete = Boolean(
            (file.telegramChatId ?? '').trim() && (file.telegramMessageId ?? '').trim(),
          );
          if (mainAnchorComplete) {
            category = 'executable';
          } else {
            // 主记录缺锚点：同归属副本里存在「当前版本」的锚点也算可执行（与 5b 同一口径）
            anchorCopy = (copiesByOwner.get(file.id) ?? [])
              .find((copy) => isUsableSourceCopyAnchor(file.size, copy)) ?? null;
            category = anchorCopy ? 'executable' : 'missingAnchor';
          }
        }
        this.state.classification[category] += 1;
        if (category === 'missingAnchor' && this.state.missingAnchorSample.length < 20) {
          this.state.missingAnchorSample.push(file.id);
        }

        if (this.state.mode === 'dry-run') {
          // dry-run 只统计：queued = 将建单数（executable + staleVersion）；
          // skipped = covered + missingAnchor（保持既有字段语义可解释）
          if (category === 'executable' || category === 'staleVersion') {
            this.state.queued += 1;
            if (this.state.sample.length < 20) this.state.sample.push(file.id);
          } else {
            this.state.skipped += 1;
          }
          continue;
        }

        if (category === 'covered' || category === 'missingAnchor') {
          this.state.skipped += 1;
          if (category === 'missingAnchor') {
            // 不 warn 刷屏：缺锚点是历史数据事实，样本已单独收集供人工核查
            this.logger.debug(
              `历史补偿跳过：源锚点不可定位（file=${file.id}，主记录与副本均无可用锚点）`,
            );
          }
          continue;
        }

        // executable / staleVersion：按既有 trigger.onFileCommitted 逻辑建单。
        // 主记录缺锚点但副本可用时用副本的 chatId/messageId/accountId
        // （与 5b 口径一致：搬运只能由持有该消息的账号执行，绝不跨账号代搬）。
        const created = await this.trigger.onFileCommitted(
          {
            ownerType: 'file',
            ownerId: file.id,
            sourceVersion,
            sourceAccountId: anchorCopy ? anchorCopy.accountId : (file.telegramSourceAccountId ?? null),
            sourceChatId: anchorCopy ? anchorCopy.chatId : (file.telegramChatId ?? null),
            sourceMessageId: anchorCopy ? anchorCopy.messageId : (file.telegramMessageId ?? null),
          },
          'web_upload',
        );
        if (created) {
          this.state.queued += 1;
          if (this.state.sample.length < 20) this.state.sample.push(file.id);
        } else {
          // 事件范围被规则过滤（例如 includeWebUploads=false）或触发失败
          this.state.skipped += 1;
        }
      }

      this.state.updatedAt = new Date().toISOString();
      await sleep(BACKFILL_BATCH_DELAY_MS);
    }

    this.state.status = 'completed';
    this.state.finishedAt = new Date().toISOString();
    this.logger.log(`历史补偿达到上限并结束：扫描 ${this.state.scanned}，入队 ${this.state.queued}`);
  }

  /**
   * 单批任务的版本覆盖情况（**一条聚合查询**，替代逐文件 count 的 N+1）。
   *
   * 跨方言注意：`COUNT(*)` 在 PG 下返回字符串（bigint），必须 `Number(...)`；
   * 不得依赖 `affected` 之类的驱动差异字段。返回 ownerId →
   * `{ anyVersion: 任意版本任务总数, byVersion: 版本 → 任务数 }`。
   */
  private async loadBatchTaskCoverage(
    batchIds: string[],
    enabledRuleIds: string[],
  ): Promise<Map<string, { anyVersion: number; byVersion: Map<number, number> }>> {
    const result = new Map<string, { anyVersion: number; byVersion: Map<number, number> }>();
    if (batchIds.length === 0 || enabledRuleIds.length === 0) return result;

    const rows = await this.tasks.createQueryBuilder('t')
      .select('t."ownerId"', 'ownerId')
      .addSelect('t."sourceVersion"', 'sourceVersion')
      .addSelect('COUNT(*)', 'count')
      .where('t."ownerType" = :ownerType', { ownerType: 'file' })
      .andWhere('t."ruleId" IN (:...ruleIds)', { ruleIds: enabledRuleIds })
      .andWhere('t."ownerId" IN (:...ownerIds)', { ownerIds: batchIds })
      .groupBy('t."ownerId"')
      .addGroupBy('t."sourceVersion"')
      .getRawMany<{ ownerId: string; sourceVersion: string | number; count: string }>();

    for (const row of rows) {
      const ownerId = String(row.ownerId);
      // 版本归一化与文件侧一致（`Number(file.uploadVersion) || 1`），保证匹配口径相同
      const version = Number(row.sourceVersion) || 1;
      const count = Number(row.count) || 0;
      const entry = result.get(ownerId) ?? { anyVersion: 0, byVersion: new Map<number, number>() };
      entry.anyVersion += count;
      entry.byVersion.set(version, (entry.byVersion.get(version) ?? 0) + count);
      result.set(ownerId, entry);
    }
    return result;
  }
}

function createIdleState(): BackfillJobState {
  return {
    status: 'idle',
    mode: 'dry-run',
    limit: 0,
    scanned: 0,
    queued: 0,
    skipped: 0,
    sample: [],
    classification: { executable: 0, missingAnchor: 0, covered: 0, staleVersion: 0 },
    missingAnchorSample: [],
    startedAt: null,
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    lastError: null,
    cursor: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
