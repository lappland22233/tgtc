import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Readable } from 'stream';
import { TelegramMirrorRule } from '../common/entities/telegram-mirror-rule.entity';
import { TelegramMirrorTask } from '../common/entities/telegram-mirror-task.entity';
import { TelegramService } from '../telegram/telegram.service';
import { TelegramAccountPoolService } from '../telegram-account-pool/telegram-account-pool.service';
import { TelegramAccountClientService, TelegramAccountError } from '../telegram-account-pool/telegram-account-client.service';
import { AccountAttemptSample } from '../telegram-account-pool/telegram-account-pool.types';
import { AccountAwareDownloadService } from '../telegram-account-pool/account-aware-download.service';
import { FileCopyService } from '../telegram-account-pool/file-copy.service';
import { ReplicaTargetResolver } from '../telegram-account-pool/replica-target.resolver';
import { TelegramAccountsService } from '../telegram-accounts/telegram-accounts.service';
import { TelegramMirrorSourceService } from './telegram-mirror-source.service';
import { MirrorExecutionError, isAccountCredentialError } from './telegram-mirror.errors';
import { MirrorExecutionResult } from './telegram-mirror.types';

interface TargetBot {
  /**
   * `panel` = 用**账号级客户端**上传（池内账号：数据库账号或环境变量账号，需要 Token）；
   * `default` = 用默认 Bot 的单账号链路上传（无任何池内/面板候选时的最后兜底）。
   */
  kind: 'panel' | 'default';
  /** 账号外部标识（botId）：写入任务的 targetAccountId */
  accountId: string;
  /** 账号主数据行 ID（仅数据库账号有；凭据失效时用于标记 degraded） */
  rowId?: string;
  token?: string;
}

/**
 * Bot 镜像路径：**目标账号二次上传**。
 *
 * 事实边界（不可含糊）：`file_id` 按账号隔离，Bot A 的 `file_id` 不能交给 Bot B。
 * 因此备份群里的消息必须由目标 Bot 自己上传产生，目标 `file_id` 只归该账号使用。
 * 代价是文件字节会被上传两次（源→主存储群、源→备份群），这是 Telegram 的硬约束，
 * 不允许伪装成「无源转发」。
 */
@Injectable()
export class TelegramMirrorBotService {
  private readonly logger = new Logger(TelegramMirrorBotService.name);
  /** 目标账号轮转游标（权重展平后轮转，避免固定压在一个账号） */
  private cursor = 0;

  constructor(
    private readonly source: TelegramMirrorSourceService,
    private readonly telegram: TelegramService,
    private readonly pool: TelegramAccountPoolService,
    private readonly client: TelegramAccountClientService,
    private readonly downloader: AccountAwareDownloadService,
    private readonly copies: FileCopyService,
    private readonly accounts: TelegramAccountsService,
    // 统一副本目标解析（可选依赖；未装配时保持既有行为，不触发懒扩散）
    @Optional() @Inject(ReplicaTargetResolver)
    private readonly replicaTargets: ReplicaTargetResolver | null = null,
  ) {}

  async execute(task: TelegramMirrorTask, rule: TelegramMirrorRule): Promise<MirrorExecutionResult> {
    const descriptor = await this.source.describe(task.ownerType, task.ownerId);
    const expectedSize = descriptor.fileSize > 0 ? descriptor.fileSize : undefined;

    // 1) 取源流：优先走账号池（可用副本 + 加权选号 + 失败换号），否则单账号默认链路
    const { stream, size, sourceAccountId } = await this.openSourceStream(task, descriptor, expectedSize);

    // 2) 选目标账号（绝不使用源账号自己的 file_id 去上传，但同一账号可上传到备份群）
    const target = await this.resolveTargetBot(rule, sourceAccountId);
    const fileName = descriptor.fileName || 'mirror-backup';

    try {
      if (target.kind === 'panel' && target.token) {
        // 账号级上传必须计入池内运行态（在飞 + 带宽/健康采样）：
        // 否则镜像上传会绕过账号池的容量与冷却控制，把某账号压垮而不自知。
        const tracked = this.pool.beginAttempt(target.accountId);
        let uploaded: Awaited<ReturnType<TelegramMirrorBotService['uploadWithPanelAccount']>>;
        try {
          uploaded = await this.uploadWithPanelAccount({
            target,
            chatId: rule.targetChatId,
            stream,
            fileName,
            size,
          });
        } catch (error) {
          if (tracked) this.pool.finishAttempt(target.accountId, this.toFailureSample(error));
          throw error;
        }
        if (tracked) this.pool.finishAttempt(target.accountId, uploaded.sample);
        await this.recordBackupCopy(task, target.accountId, uploaded.fileId, uploaded.chatId, uploaded.messageId, size);
        this.logger.log(
          `镜像完成（bot_upload）：${task.ownerType}:${task.ownerId} → 账号 ${target.accountId} / chat ${rule.targetChatId}`,
        );
        return {
          targetAccountId: target.accountId,
          targetChatId: uploaded.chatId,
          targetMessageId: uploaded.messageId,
          targetTelegramFileId: uploaded.fileId,
          fileSize: size,
          mode: 'bot_upload',
        };
      }

      // 单账号兜底：默认 Bot 上传到备份群（需要 chatId 覆盖能力）
      const uploaded = await this.telegram.uploadFile(stream, fileName, undefined, size, {
        chatId: rule.targetChatId,
      });
      if (!uploaded.file_id || !uploaded.message_id || !uploaded.chat_id) {
        throw new MirrorExecutionError(
          'receipt_incomplete',
          '默认 Bot 上传回执缺少消息定位信息（message_id/chat_id），无法确认备份可用',
          'retryable',
        );
      }
      await this.recordBackupCopy(
        task,
        target.accountId,
        uploaded.file_id,
        uploaded.chat_id,
        uploaded.message_id,
        size,
      );
      this.logger.log(
        `镜像完成（bot_upload / 单账号链路）：${task.ownerType}:${task.ownerId} → chat ${uploaded.chat_id}`,
      );
      return {
        targetAccountId: target.accountId,
        targetChatId: uploaded.chat_id,
        targetMessageId: uploaded.message_id,
        targetTelegramFileId: uploaded.file_id,
        fileSize: size,
        mode: 'bot_upload',
      };
    } finally {
      // 流只能消费一次：无论成功失败都释放，避免连接与内存悬挂
      if (!stream.destroyed) {
        try {
          stream.destroy();
        } catch {
          // 忽略清理异常
        }
      }
    }
  }

  /** 账号级上传：凭据失效时明确标记账号降级，让管理员在后台看见并重新轮换 Token */
  private async uploadWithPanelAccount(params: {
    target: TargetBot;
    chatId: string;
    stream: Readable;
    fileName: string;
    size: number;
  }): Promise<{
    fileId: string;
    fileSize: number;
    chatId: string;
    messageId: string;
    fileUniqueId: string | null;
    sample: AccountAttemptSample;
  }> {
    try {
      return await this.client.sendDocumentStream(
        params.target.accountId,
        params.target.token as string,
        params.chatId,
        params.stream,
        params.fileName,
        params.size,
      );
    } catch (error) {
      if (params.target.rowId && isAccountCredentialError(error)) {
        await this.accounts.markDegraded(
          params.target.rowId,
          'bot_token_invalid',
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  }

  private async openSourceStream(
    task: TelegramMirrorTask,
    descriptor: { fileId: string | null; sourceAccountId?: string | null },
    expectedSize?: number,
  ): Promise<{ stream: Readable; size: number; sourceAccountId: string | null }> {
    // 1) 优先走账号池：按副本记录加权选号（失败自动换号）
    const readyCopies = await this.copies.listReady(task.ownerType, task.ownerId).catch(() => []);
    if (readyCopies.length > 0 && this.downloader.isActive()) {
      const opened = await this.downloader.openStream({
        ownerType: task.ownerType,
        ownerId: task.ownerId,
        expectedSize,
        // 已有锚点 file_id 时不请求懒扩散：镜像自身就要把这些字节再上传一次，
        // 同时扩散会成倍放大出网带宽（目标数量仍由统一解析器决定，见 desiredReplicas）。
        fileName: descriptor.fileId ? undefined : 'mirror-backup',
        desiredReplicas: await this.replicaTargets?.desiredReplicas(),
      });
      if (opened) {
        const size = this.resolveSize(opened.info.file_size, expectedSize, opened.stream);
        return { stream: opened.stream, size, sourceAccountId: opened.accountId };
      }
      this.logger.warn(`账号池回源失败（${task.ownerType}:${task.ownerId}），尝试源账号锚定取源`);
    }

    // 2) 源账号锚定：用「产生该 file_id 的账号」自己的凭据取流。
    //    这是池化模式下唯一安全的兜底——把 A 账号的 file_id 交给 B 账号会得到上游 502。
    const anchoredAccountId = task.sourceAccountId ?? descriptor.sourceAccountId ?? null;
    if (descriptor.fileId && anchoredAccountId && this.downloader.isActive()) {
      const opened = await this.downloader.openSourceStream({
        accountId: anchoredAccountId,
        fileId: descriptor.fileId,
        expectedSize,
      });
      if (opened) {
        const size = this.resolveSize(opened.info.file_size, expectedSize, opened.stream);
        return { stream: opened.stream, size, sourceAccountId: opened.accountId };
      }
      this.logger.warn(`源账号 ${anchoredAccountId} 锚定取源失败（${task.ownerType}:${task.ownerId}）`);
    }

    if (!descriptor.fileId) {
      throw new MirrorExecutionError(
        'no_source_stream',
        '无法取得源文件流（缺少 file_id 且无可用副本记录）',
        'blocked',
      );
    }

    // 3) 单账号链路：安全条件 =「未启用账号池」或「产生该 file_id 的账号就是默认 Bot」。
    //
    // 与 Bot 直链下载控制器保持同一回退矩阵：默认 Token 产生的 file_id 只有默认
    // Token 能取，归属是**可确认**的，因此允许走默认链路；若既无副本、归属也不明，
    // 则必须 fail-closed——绝不用默认账号去猜别的账号的 file_id。
    const defaultBotId = ((process.env.TELEGRAM_BOT_TOKEN || '').split(':')[0] || '').trim();
    const anchoredIsDefaultBot = Boolean(defaultBotId) && anchoredAccountId === defaultBotId;
    if (this.pool.isActive() && !anchoredIsDefaultBot) {
      throw new MirrorExecutionError(
        'source_account_unresolved',
        '账号池已启用，但既没有可用副本记录也无法确认产生该 file_id 的账号；'
        + '请先让收到文件的账号登记副本，或修正任务来源',
        'blocked',
      );
    }
    const fallback = await this.telegram.getRealtimeFileStream(descriptor.fileId, expectedSize);
    const size = this.resolveSize(fallback.info.file_size, expectedSize, fallback.stream);
    return { stream: fallback.stream, size, sourceAccountId: task.sourceAccountId ?? null };
  }

  /** 上传前必须确定字节数：未知大小会导致上游 502（Exact file size is unavailable），也不允许静默上传 */
  private resolveSize(upstreamSize: number, expectedSize: number | undefined, stream: Readable): number {
    const candidate = upstreamSize > 0 ? upstreamSize : (expectedSize ?? 0);
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
      try {
        stream.destroy();
      } catch {
        // 忽略清理异常
      }
      throw new MirrorExecutionError(
        'source_size_unknown',
        '无法确定源文件大小，已拒绝上传（避免产生不可校验的备份）',
        'blocked',
      );
    }
    return candidate;
  }

  /**
   * 选择镜像目标 Bot。
   *
   * 降级链（顺序即优先级）：
   * 1. **规则指定账号**：管理员显式意图，不做负载改写；
   * 2. **账号池评分选号**：池可用时用与下载/上传同一套 `pool.select`
   *    （权重 × 带宽 × 健康 × 容量，排除源账号）在「已配置存储 Chat」的账号中选号；
   * 3. **面板账号权重轮转**：池不可用时保留原 `pickWeighted`（非池部署行为逐字节不变）；
   * 4. **默认单账号兜底**：无任何候选时回落默认 Bot；池已启用却无候选才累计 `fallbacks`。
   */
  private async resolveTargetBot(rule: TelegramMirrorRule, sourceAccountId: string | null): Promise<TargetBot> {
    let candidates: Awaited<ReturnType<TelegramAccountsService['resolveEnabledBotAccounts']>> = [];
    try {
      candidates = await this.accounts.resolveEnabledBotAccounts();
    } catch (error) {
      this.logger.warn(`读取面板 Bot 账号失败：${error instanceof Error ? error.message : String(error)}`);
    }

    if (rule.preferredAccountId) {
      const preferred = candidates.find(
        (item) => item.accountId === rule.preferredAccountId || item.id === rule.preferredAccountId,
      );
      if (preferred) {
        return { kind: 'panel', accountId: preferred.accountId, rowId: preferred.id, token: preferred.token };
      }
      // 环境变量账号（主 Bot 或 TELEGRAM_ACCOUNT_POOL 配置项）不在数据库，但同样可被规则指定
      const preferredEnv = this.pool.getConfig(rule.preferredAccountId);
      if (preferredEnv?.enabled && preferredEnv.chatId) {
        return { kind: 'panel', accountId: preferredEnv.id, token: preferredEnv.token };
      }
      this.logger.warn(`规则指定的优先账号 ${rule.preferredAccountId} 不可用，改为按负载选择`);
    }

    // 账号池可用 → 复用统一调度器（与下载/上传同一套评分与冷却）
    if (this.pool.isActive()) {
      const storageIds = this.pool.storageAccountIds();
      // 注意：`pool.select()` 把**空数组**当作「不限定候选 = 全池」，
      // 所以必须先确认候选非空，绝不能把空数组传进去……
      if (storageIds.length > 0) {
        const excludingSource = storageIds.filter((id) => id !== sourceAccountId);
        const selection = this.pool.select(excludingSource.length > 0 ? excludingSource : storageIds);
        const account = selection ? this.pool.getConfig(selection.accountId) : null;
        if (selection && account) {
          this.logger.log(`镜像目标账号按负载选择 ${account.id}（依据 ${selection.reason}）`);
          return {
            kind: 'panel',
            accountId: account.id,
            rowId: candidates.find((item) => item.accountId === account.id)?.id,
            token: account.token,
          };
        }
      }
      // ……否则会选中「未配置存储 Chat」的账号，产生必败上传且回退计数失真。
      //
      // 池已启用但无可用候选（无存储 Chat / 全部冷却或满载）：不再用 pickWeighted
      // 绕过池的冷却与容量判定，直接按默认兜底并计入回退。
      const defaultBotId = ((process.env.TELEGRAM_BOT_TOKEN || '').split(':')[0] || '').trim();
      this.pool.bumpCounter('fallbacks');
      return { kind: 'default', accountId: defaultBotId || 'default' };
    }

    // 池未启用：保留既有「面板账号权重展平 + 游标」选号（非池部署行为逐字节不变）
    const excludingSourceRows = candidates.filter((item) => item.accountId !== sourceAccountId);
    const picked = this.pickWeighted(excludingSourceRows.length > 0 ? excludingSourceRows : candidates);
    if (picked) return { kind: 'panel', accountId: picked.accountId, rowId: picked.id, token: picked.token };

    const defaultBotId = ((process.env.TELEGRAM_BOT_TOKEN || '').split(':')[0] || '').trim();
    return { kind: 'default', accountId: defaultBotId || 'default' };
  }

  /** 失败尝试的采样（供账号池更新健康度与冷却） */
  private toFailureSample(error: unknown): AccountAttemptSample {
    const accountError = error instanceof TelegramAccountError ? error : null;
    return {
      ok: false,
      failureKind: accountError?.kind ?? 'other',
      status: accountError?.status,
      retryAfterSeconds: accountError?.retryAfterSeconds,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  /** 权重展平 + 游标轮转：权重高者被选中概率更高，同权重账号均匀分流 */
  private pickWeighted<T extends { weight: number }>(items: T[]): T | null {
    if (items.length === 0) return null;
    const expanded: T[] = [];
    for (const item of items) {
      const weight = Math.max(1, Math.min(Math.floor(item.weight) || 1, 10));
      for (let index = 0; index < weight; index += 1) expanded.push(item);
    }
    const chosen = expanded[this.cursor % expanded.length];
    this.cursor = (this.cursor + 1) % Number.MAX_SAFE_INTEGER;
    return chosen;
  }

  /**
   * 登记备份副本（best-effort）。
   *
   * 为什么写在副本表：备份群里由该 Bot 上传的消息同样是「该账号持有的 file_id」，
   * 可以作为后续下载的候选副本；登记失败不影响镜像结论（任务状态才是事实来源）。
   */
  private async recordBackupCopy(
    task: TelegramMirrorTask,
    accountId: string,
    telegramFileId: string,
    chatId: string,
    messageId: string,
    fileSize: number,
  ): Promise<void> {
    try {
      await this.copies.upsertReady({
        ownerType: task.ownerType,
        ownerId: task.ownerId,
        accountId,
        telegramFileId,
        chatId,
        messageId,
        fileSize,
        source: 'replicated',
      });
    } catch (error) {
      this.logger.warn(
        `备份副本登记失败（任务 ${task.id}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
