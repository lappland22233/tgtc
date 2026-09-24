import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';
import { AccountPoolCounterKey } from './telegram-account-pool.types';
import { TelegramAccountClientService, TelegramAccountError } from './telegram-account-client.service';
import { TelegramAccountPoolService } from './telegram-account-pool.service';

/** 单次上传最多尝试的账号数（首次选择 + 2 次换号），避免长尾把上传拖死 */
const MAX_ACCOUNT_ATTEMPTS = 3;

/** 池化上传的回执（包含**实际上传账号**，调用方据此登记主副本归属） */
export interface AccountUploadResult {
  fileId: string;
  fileSize: number;
  chatId: string;
  messageId: string;
  fileUniqueId: string | null;
  /** 实际上传账号 id —— 主副本定位与副本表必须用这个值，绝不能用默认 Bot 猜测 */
  accountId: string;
  selectionReason: string;
}

export interface AccountUploadParams {
  filename: string;
  /**
   * 上传字节数。流式上传必须提供：缺失时 Telegram 需要先缓冲整个文件，
   * 与「边读边传」的既有语义不一致，因此调用方必须显式给出。
   */
  knownLength: number;
  /**
   * 每次尝试都必须**新开**一个流（流只能被消费一次）。
   * 磁盘文件用 `createReadStream`，内存 Buffer 用 `Readable.from`。
   */
  openStream: () => Readable;
  signal?: AbortSignal;
}

/**
 * 账号感知的上传入口（新文件写入的首字节落点）。
 *
 * 与 `AccountAwareDownloadService` 对称：这里解决「新文件由哪个账号持有」的问题——
 * - 候选只取**已配置存储 Chat** 的账号（没有存储 Chat 的账号上传必失败）；
 * - 由账号池按「带宽 × 健康度 × 容量 × 权重」选号，失败（限流/网络/权限）→ 冷却 → 换号；
 * - 传输结束把结果回报账号池，带宽 EWMA 与健康度实时更新。
 *
 * 返回 `null` 表示「本服务无法完成上传」，由调用方回退**默认单账号链路**。
 * 这不是 fail-open 风险：回退后产生的 `file_id` 属于默认 Bot，调用方按返回的账号登记即可，
 * 不会出现「A 的 file_id 记成 B 的归属」。真正的 fail-closed 约束在**回源**侧
 * （归属不明的 file_id 绝不用默认账号去猜）。
 */
@Injectable()
export class AccountAwareUploadService {
  private readonly logger = new Logger(AccountAwareUploadService.name);
  /** 「无存储 Chat 账号」告警去重（配置缺失是持续状态，不应每条上传都刷日志） */
  private warnedNoStorageAccount = false;
  /** 「选号无可用候选」warn 限频时间戳：账号持续冷却时该分支每次上传都会命中，避免刷屏 */
  private lastNoCandidateLogAt = 0;

  constructor(
    private readonly pool: TelegramAccountPoolService,
    private readonly client: TelegramAccountClientService,
  ) {}

  isActive(): boolean {
    return this.pool.isActive();
  }

  /** 未生效原因（用于区分「服务健康」与「账号池已启用但未生效」） */
  inactiveReason(): string | null {
    return this.pool.inactiveReason();
  }

  /** 计数透传（诊断与告警用） */
  bumpCounter(key: AccountPoolCounterKey, delta = 1): void {
    this.pool.bumpCounter(key, delta);
  }

  /**
   * 按负载选号上传；全部候选失败时返回 null（交由调用方回退默认链路）。
   */
  async upload(params: AccountUploadParams): Promise<AccountUploadResult | null> {
    if (!this.pool.isActive()) return null;

    const candidates = this.pool.storageAccountIds();
    if (candidates.length === 0) {
      // 每次上传都告警会刷屏（配置缺失是持续状态）；同一进程只提示一次，
      // 池初始化时的账号配置告警已给出具体账号名。
      if (!this.warnedNoStorageAccount) {
        this.warnedNoStorageAccount = true;
        this.logger.warn(
          '账号池已启用但没有任何「已配置存储 Chat」的账号，上传回退默认单账号链路（本提示只出现一次）',
        );
      }
      return null;
    }

    const excluded = new Set<string>();
    for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt += 1) {
      const available = candidates.filter((accountId) => !excluded.has(accountId));
      if (available.length === 0) break;

      const selection = this.pool.select(available);
      if (!selection) {
        // 候选都存在但当前不可调度（冷却/满载/禁用）：回退单账号链路。
        this.logger.debug('池化上传选号无可用候选（冷却/满载/禁用），回退单账号链路');
        // 限频 warn（60s 一次）：账号持续冷却时该分支每次上传都会命中，不设限会刷屏；
        // 但完全静默会让「池化为何未生效」在生产不可诊断，故保留一条带计数的告警。
        const now = Date.now();
        if (now - this.lastNoCandidateLogAt >= 60_000) {
          this.lastNoCandidateLogAt = now;
          this.logger.warn(
            `池化上传选号无可用候选（冷却/满载/禁用），回退单账号链路（候选 ${available.length}，已排除 ${excluded.size}）`,
          );
        }
        break;
      }

      const account = this.pool.getConfig(selection.accountId);
      if (!account || !account.chatId) {
        excluded.add(selection.accountId);
        continue;
      }
      if (!this.pool.beginAttempt(account.id)) {
        excluded.add(account.id);
        continue;
      }

      if (attempt > 0) this.pool.bumpCounter('failovers');
      this.pool.bumpCounter('selections');

      let stream: Readable | null = null;
      try {
        stream = params.openStream();
        const result = await this.client.sendDocumentStream(
          account.id,
          account.token,
          account.chatId,
          stream,
          params.filename,
          params.knownLength,
          { signal: params.signal },
        );
        this.pool.finishAttempt(account.id, result.sample);
        this.logger.log(
          `按负载选择账号 ${account.id} 上传（${params.filename}，${params.knownLength} 字节，依据 ${selection.reason}）`,
        );
        return {
          fileId: result.fileId,
          fileSize: result.fileSize,
          chatId: result.chatId,
          messageId: result.messageId,
          fileUniqueId: result.fileUniqueId,
          accountId: account.id,
          selectionReason: selection.reason,
        };
      } catch (error) {
        this.finishFailed(account.id, error);
        excluded.add(account.id);
        this.logger.warn(
          `账号 ${account.id} 上传失败（${error instanceof TelegramAccountError ? error.kind : 'other'}），尝试换号：`
          + `${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
      } finally {
        // 失败换号时必须销毁上一个流，避免句柄泄漏（成功路径由客户端内部释放）
        if (stream && !stream.destroyed && !stream.readableEnded) {
          try {
            stream.destroy();
          } catch {
            // 忽略清理异常
          }
        }
      }
    }

    return null;
  }

  /** 记录一次失败的尝试（按错误分类进入冷却） */
  private finishFailed(accountId: string, error: unknown): void {
    const accountError = error instanceof TelegramAccountError ? error : null;
    this.pool.finishAttempt(accountId, {
      ok: false,
      failureKind: accountError?.kind ?? 'other',
      status: accountError?.status,
      retryAfterSeconds: accountError?.retryAfterSeconds,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
