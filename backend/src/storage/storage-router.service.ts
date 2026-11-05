import { Injectable, Logger } from '@nestjs/common';
import { ConfigCacheService } from '../common/services/config-cache.service';
import type { RemoteStorageBackendType, StorageBackendType } from '../common/entities/storage-backend.entity';
import { maskIdentifier } from '../telegram-accounts/telegram-account-view';
import { StorageAccountSchedulerService, QUOTA_SIZE_FACTOR, QUOTA_HEADROOM_BYTES } from './storage-account-scheduler.service';
import { StorageBackendsService } from './storage-backends.service';
import { StorageDriverRegistry } from './storage-driver.registry';
import {
  isRemoteStorageBackend,
  StorageAccountError,
  StorageAccountContext,
  StorageDownloadResult,
  StorageDownloadUnavailableError,
  StorageFailureKind,
  StorageUploadParams,
  StorageUploadReceipt,
  StorageUploadUnavailableError,
} from './storage.types';

/** 单次上传最多尝试的账号数（首次选择 + 2 次换号，与 TG 池化上传同口径） */
const MAX_ACCOUNT_ATTEMPTS = 3;
/** 默认存储后端配置键（SystemConfig，热更新；会话创建时冻结到 File 记录） */
export const STORAGE_DEFAULT_BACKEND_KEY = 'STORAGE_DEFAULT_BACKEND';

/**
 * 存储路由编排：上传选号换号 + 回源 fail-closed + 对象生命周期。
 *
 * 上传：按「带宽 × 健康度 × 容量 × 权重（× 剩余配额）」选号，失败冷却换号，
 * 全部候选不可用返回可重试 503（admissionOnly 语义与 TG 池一致：尚未发出任何
 * 远端请求时调用方等待名额重试，不消耗 Bull 失败次数）。
 *
 * 回源：对象引用与账号强绑定（S3 key 属于特定 bucket、GDrive fileId 属于特定
 * 账号），**绝不跨账号猜测**——账号撤销/凭据失效/限流时返回可诊断 503，
 * 与 TG `file_id` 账号隔离同一 fail-closed 红线。
 *
 * Telegram 不经本服务：TG 分支保留在 FileService 原链路（池化 + 镜像 + 副本），
 * 由调用方按 `file.storageBackend` 分发，保证 TG 行为逐字节不变。
 */
@Injectable()
export class StorageRouterService {
  private readonly logger = new Logger(StorageRouterService.name);
  /** 「配置的后端无可用账号，回退 telegram」告警去重 */
  private warnedFallback = false;

  constructor(
    private readonly configCache: ConfigCacheService,
    private readonly backends: StorageBackendsService,
    private readonly scheduler: StorageAccountSchedulerService,
    private readonly registry: StorageDriverRegistry,
  ) {}

  /**
   * 上传默认后端（会话创建时冻结）。配置了非 TG 后端但无 active 账号时
   * 回退 telegram（配置错误不应让整站上传瘫痪），并告警一次。
   */
  async getDefaultBackendType(): Promise<StorageBackendType> {
    const raw = (await this.configCache.get(STORAGE_DEFAULT_BACKEND_KEY, 'telegram')).trim();
    if (!isRemoteStorageBackend(raw)) return 'telegram';
    if (this.scheduler.activeAccountIds(raw).length === 0) {
      if (!this.warnedFallback) {
        this.warnedFallback = true;
        this.logger.warn(`默认存储后端 ${raw} 没有可用账号，上传回退 telegram（本提示只出现一次）`);
      }
      return 'telegram';
    }
    this.warnedFallback = false;
    return raw;
  }

  /** 管理端可选后端列表（telegram 恒在；其余仅列出有 active 账号的类型） */
  availableBackendTypes(): StorageBackendType[] {
    const result: StorageBackendType[] = ['telegram'];
    for (const type of this.registry.types()) {
      if (this.scheduler.activeAccountIds(type).length > 0) result.push(type);
    }
    return result;
  }

  /** 池化上传（选号 + 失败换号 + 采样回报） */
  async upload(params: StorageUploadParams & { backendType: RemoteStorageBackendType }): Promise<StorageUploadReceipt> {
    if (params.signal?.aborted) throw new Error('上传已取消');
    const driver = this.registry.get(params.backendType);
    if (!driver) throw new StorageUploadUnavailableError(false);
    const candidates = this.scheduler.activeAccountIds(params.backendType);
    if (candidates.length === 0) throw new StorageUploadUnavailableError(false);

    const excluded = new Set<string>();
    for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt += 1) {
      const available = candidates.filter((id) => !excluded.has(id));
      if (available.length === 0) break;
      const selection = this.scheduler.select(params.backendType, Date.now(), {
        requiredBytes: params.knownLength,
        exclude: excluded,
      });
      if (!selection) {
        // 候选都存在但当前不可调度（冷却/满载/配额不足）：与 TG 同口径，
        // 首次即无候选 → admissionOnly（远端零请求，调用方等待名额）
        this.maybeAlertCapacityExhausted(params.backendType, params.knownLength);
        if (excluded.size === 0) throw new StorageUploadUnavailableError(true);
        break;
      }
      if (!this.scheduler.beginAttempt(selection.accountId, Date.now(), params.knownLength)) {
        excluded.add(selection.accountId);
        continue;
      }

      const startedAt = Date.now();
      try {
        // 上下文解析也属于本次 admission：即使数据库读取抛错，也必须在 catch 中释放 inflight。
        const ctx = await this.backends.resolveContext(selection.accountId);
        if (!ctx) {
          this.scheduler.finishAttempt(selection.accountId, { ok: false, failureKind: 'auth' });
          void this.backends.recordOutcome(selection.accountId, { ok: false, failureKind: 'auth', errorMessage: '凭据不可用' });
          excluded.add(selection.accountId);
          continue;
        }
        const result = await driver.upload(ctx, params);
        const durationMs = Date.now() - startedAt;
        this.scheduler.finishAttempt(selection.accountId, { ok: true, bytes: result.size, durationMs });
        void this.backends.recordOutcome(selection.accountId, { ok: true });
        // GDrive 上传成功后异步刷新配额（调度硬准入依赖最新剩余空间）
        if (params.backendType === 'gdrive') {
          void this.backends.refreshQuota(selection.accountId).catch(() => {});
        }
        this.logger.log(
          `存储后端 ${params.backendType} 账号 ${maskIdentifier(selection.accountId)} 上传完成`
          + `（${params.knownLength} 字节，依据 ${selection.reason}）`,
        );
        return {
          backendType: params.backendType,
          accountId: selection.accountId,
          objectRef: result.objectRef,
          size: result.size,
        };
      } catch (error) {
        if (params.signal?.aborted) {
          this.scheduler.releaseAttempt(selection.accountId);
          throw error;
        }
        const kind = error instanceof StorageAccountError ? error.kind : 'other';
        const retryAfterSeconds = error instanceof StorageAccountError ? error.retryAfterSeconds : undefined;
        this.scheduler.finishAttempt(selection.accountId, {
          ok: false,
          failureKind: kind,
          retryAfterSeconds,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        void this.backends.recordOutcome(selection.accountId, {
          ok: false,
          failureKind: kind,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        excluded.add(selection.accountId);
        this.logger.warn(
          `存储账号 ${maskIdentifier(selection.accountId)} 上传失败（${kind}），尝试换号：`
          + `${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
      }
    }
    this.maybeAlertCapacityExhausted(params.backendType, params.knownLength);
    throw new StorageUploadUnavailableError(false);
  }

  /**
   * GDrive 容量耗尽告警判定（与调度器硬准入同口径）：仅当全部启用账号的
   * 剩余配额都装不下本次文件时才触发（避免瞬时冷却/满载误报）；
   * 引擎内置 30 分钟原子冷却去重，best-effort 绝不影响上传结论。
   */
  private maybeAlertCapacityExhausted(backendType: RemoteStorageBackendType, requiredBytes: number): void {
    if (backendType !== 'gdrive') return;
    const ids = this.scheduler.activeAccountIds('gdrive');
    if (ids.length === 0) return;
    const allFull = ids.every((id) => {
      const rt = this.scheduler.getRuntime(id);
      if (!rt || rt.quotaTotalBytes === null) return false;
      return rt.quotaTotalBytes - rt.quotaUsedBytes <= requiredBytes * QUOTA_SIZE_FACTOR + QUOTA_HEADROOM_BYTES;
    });
    if (allFull) {
      void this.backends.raiseCapacityExhaustedAlert('gdrive', ids.length);
    }
  }

  /**
   * 回源取流（对象所属账号唯一候选；冷却/满载时返回可诊断 503）。
   * 流结束后自动回报采样（健康度/在飞名额），调用方无需关心记账。
   */
  async openDownloadStream(params: {
    backendType: RemoteStorageBackendType;
    accountId: string;
    objectRef: string;
    range?: { start: number; end?: number };
    signal?: AbortSignal;
    expectedSize?: number;
  }): Promise<StorageDownloadResult> {
    const driver = this.registry.get(params.backendType);
    if (!driver) throw new StorageDownloadUnavailableError('driver_missing');
    if (!this.scheduler.hasAccount(params.accountId)) {
      throw new StorageDownloadUnavailableError('account_unknown', '文件暂不可用：存储账号不存在或已被移除，请联系管理员');
    }
    const selection = this.scheduler.select(params.backendType, Date.now(), { candidateIds: [params.accountId] });
    if (!selection || !this.scheduler.beginAttempt(params.accountId)) {
      throw new StorageDownloadUnavailableError('account_busy');
    }
    let ctx: StorageAccountContext | null;
    try {
      ctx = await this.backends.resolveContext(params.accountId);
    } catch (error) {
      const kind = error instanceof StorageAccountError ? error.kind : 'other';
      this.scheduler.finishAttempt(params.accountId, {
        ok: false,
        failureKind: kind,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      void this.backends.recordOutcome(params.accountId, {
        ok: false,
        failureKind: kind,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw new StorageDownloadUnavailableError('upstream_failed');
    }
    if (!ctx) {
      this.scheduler.finishAttempt(params.accountId, { ok: false, failureKind: 'auth' });
      void this.backends.recordOutcome(params.accountId, { ok: false, failureKind: 'auth', errorMessage: '凭据不可用' });
      throw new StorageDownloadUnavailableError('credential_unavailable', '文件暂不可用：存储账号凭据失效，请联系管理员轮换');
    }

    const startedAt = Date.now();
    let result: StorageDownloadResult;
    try {
      result = await driver.openDownloadStream(ctx, {
        objectRef: params.objectRef,
        range: params.range,
        signal: params.signal,
      });
    } catch (error) {
      const kind = error instanceof StorageAccountError ? error.kind : 'other';
      this.scheduler.finishAttempt(params.accountId, {
        ok: false,
        failureKind: kind,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      void this.backends.recordOutcome(params.accountId, {
        ok: false,
        failureKind: kind,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw new StorageDownloadUnavailableError('upstream_failed');
    }

    // 流生命周期记账：end=成功；error=失败；提前 close（客户端中止）=归还名额不计失败
    let settled = false;
    const settle = (ok: boolean, failureKind?: StorageFailureKind) => {
      if (settled) return;
      settled = true;
      const durationMs = Date.now() - startedAt;
      if (ok) {
        this.scheduler.finishAttempt(params.accountId, { ok: true, bytes: params.expectedSize, durationMs });
        void this.backends.recordOutcome(params.accountId, { ok: true });
      } else if (failureKind) {
        this.scheduler.finishAttempt(params.accountId, { ok: false, failureKind });
        void this.backends.recordOutcome(params.accountId, { ok: false, failureKind });
      } else {
        this.scheduler.releaseAttempt(params.accountId);
      }
    };
    result.stream.once('end', () => settle(true));
    result.stream.once('error', () => settle(false, 'network'));
    result.stream.once('close', () => settle(false));
    return result;
  }

  /** 文件校验用：只有驱动确认的缺失对象返回 exists=false；暂时不可用会抛错供校验侧计为临时失败。 */
  async headObject(
    backendType: RemoteStorageBackendType,
    accountId: string,
    objectRef: string,
  ): Promise<{ exists: boolean; size?: number }> {
    const driver = this.registry.get(backendType);
    if (!driver) throw new StorageDownloadUnavailableError('driver_missing');
    try {
      const ctx = await this.backends.resolveContext(accountId);
      if (!ctx) throw new StorageDownloadUnavailableError('credential_unavailable');
      return await driver.headObject(ctx, objectRef);
    } catch (error) {
      this.logger.debug(`对象 head 失败（${backendType}/${maskIdentifier(accountId)}）：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * best-effort 远端对象删除（覆盖提交后 / 永久删除后，调用方已完成共享引用检查）。
   * 失败只告警返回 false，绝不影响调用方主流程结论。
   */
  async deleteRemoteObject(
    backendType: RemoteStorageBackendType,
    accountId: string,
    objectRef: string,
  ): Promise<boolean> {
    const driver = this.registry.get(backendType);
    if (!driver) return false;
    const ctx = await this.backends.resolveContext(accountId);
    if (!ctx) {
      this.logger.warn(`远端对象删除跳过：账号 ${maskIdentifier(accountId)} 凭据不可用（对象残留，需人工清理）`);
      return false;
    }
    try {
      await driver.deleteObject(ctx, objectRef);
      return true;
    } catch (error) {
      this.logger.warn(
        `远端对象删除失败（${backendType}/${maskIdentifier(accountId)}，对象残留）：`
        + `${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
      );
      return false;
    }
  }
}
