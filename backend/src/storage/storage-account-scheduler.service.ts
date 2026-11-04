import { Injectable, Logger } from '@nestjs/common';
import type { RemoteStorageBackendType, StorageBackend } from '../common/entities/storage-backend.entity';
import type { StorageFailureKind, StorageQuota } from './storage.types';

/** EWMA 平滑系数（与 TG 账号池一致：0.3 ≈ 约 3 次采样后逼近真实值） */
const EWMA_ALPHA = 0.3;
/** 未探测过带宽时的中性分（避免新账号被永久压制） */
const NEUTRAL_BANDWIDTH_SCORE = 0.5;
/** 各类失败的冷却基数（毫秒），按连续失败次数指数放大且不超过上限 */
const COOLDOWN_BASE_MS: Record<StorageFailureKind, number> = {
  flood: 60_000,
  // 配额耗尽不会秒级恢复，但刷新配额后可能发现其它账号释放了空间，取中等冷却
  quota: 120_000,
  // 凭据失效通常不可自愈（需要管理员轮换），长冷却避免反复撞上游
  auth: 600_000,
  unavailable: 30_000,
  timeout: 15_000,
  network: 10_000,
  other: 10_000,
};
const COOLDOWN_MAX_MS = 30 * 60 * 1000;
/** GDrive 硬准入余量：文件大小 × 1.2 + 256MB（计划口径；导出供路由层容量告警判定同口径复用） */
export const QUOTA_SIZE_FACTOR = 1.2;
export const QUOTA_HEADROOM_BYTES = 256 * 1024 * 1024;
/** 未刷新过配额时的中性配额分（不永久压制新授权账号） */
const NEUTRAL_QUOTA_SCORE = 0.5;

/** 一次传输尝试的回报采样（成功带字节数/耗时，失败带分类） */
export interface StorageAttemptSample {
  ok: boolean;
  bytes?: number;
  durationMs?: number;
  failureKind?: StorageFailureKind;
  retryAfterSeconds?: number;
  errorMessage?: string;
}

export interface StorageSelection {
  accountId: string;
  reason: string;
}

interface StorageAccountRuntime {
  accountId: string;
  type: RemoteStorageBackendType;
  enabled: boolean;
  status: string;
  weight: number;
  maxInflight: number;
  inflight: number;
  ewmaBandwidthMbps: number | null;
  ewmaSuccess: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  quotaTotalBytes: number | null;
  quotaUsedBytes: number;
  quotaCheckedAt: number;
}

/**
 * 通用存储账号调度器：多账号注册表 + 加权负载选择 + 失败冷却 + 配额准入。
 *
 * 选择口径与 TG 账号池同源（不重构 TG 池本体，避免动摇测试最密集的模块）：
 * ```
 * 可调度条件： enabled && status=active && 未冷却 && inflight < maxInflight
 * 带宽分   = ewmaBandwidth / 同类型池内最优带宽   （未探测 → 0.5 中性值）
 * 健康分   = clamp(ewmaSuccess, 0.05, 1)
 * 容量分   = 1 - inflight / maxInflight            （满载 → 0，天然平滑分流）
 * 配额分   = 剩余配额 / 总配额                      （仅 GDrive；无配额概念 → 1）
 * 得分     = weight × (0.5×带宽分 + 0.5×健康分) × 容量分 × 配额分
 * ```
 *
 * GDrive 硬准入：剩余配额必须 > 文件大小 × 1.2 + 256MB，否则该账号不参与本次上传
 * 选号（个人账号 15GB，写满即换下一个账号——这就是「账号池扩展存储空间」的落点）。
 *
 * 本服务只做「选择与记账」，不发请求：实际 I/O 由各驱动执行，完成后由
 * StorageRouterService 回报采样。健康字段持久化由 StorageBackendsService 承担。
 */
@Injectable()
export class StorageAccountSchedulerService {
  private readonly logger = new Logger(StorageAccountSchedulerService.name);
  private readonly runtimes = new Map<string, StorageAccountRuntime>();
  /** 轮转起点：相同得分候选的确定性均衡（候选按 account id 规范排序） */
  private rotateCursor = 0;

  /** 以 DB 事实全量同步运行时注册表（CRUD / 启停 / 撤销后调用） */
  syncAccounts(rows: StorageBackend[]): void {
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      const existing = this.runtimes.get(row.id);
      if (existing) {
        existing.enabled = row.enabled;
        existing.status = row.status;
        existing.weight = Math.max(1, row.weight || 1);
        existing.maxInflight = Math.max(1, row.maxInflight || 8);
        existing.quotaTotalBytes = row.quotaTotalBytes === null ? null : Number(row.quotaTotalBytes);
        existing.quotaUsedBytes = Number(row.quotaUsedBytes ?? 0);
        existing.quotaCheckedAt = row.lastQuotaCheckAt ? row.lastQuotaCheckAt.getTime() : existing.quotaCheckedAt;
      } else {
        this.runtimes.set(row.id, {
          accountId: row.id,
          type: row.type,
          enabled: row.enabled,
          status: row.status,
          weight: Math.max(1, row.weight || 1),
          maxInflight: Math.max(1, row.maxInflight || 8),
          inflight: 0,
          ewmaBandwidthMbps: null,
          ewmaSuccess: 1,
          consecutiveFailures: 0,
          cooldownUntil: 0,
          quotaTotalBytes: row.quotaTotalBytes === null ? null : Number(row.quotaTotalBytes),
          quotaUsedBytes: Number(row.quotaUsedBytes ?? 0),
          quotaCheckedAt: row.lastQuotaCheckAt ? row.lastQuotaCheckAt.getTime() : 0,
        });
      }
    }
    for (const id of Array.from(this.runtimes.keys())) {
      if (!seen.has(id)) this.runtimes.delete(id);
    }
  }

  /** 某后端类型下可参与新任务的账号（enabled && active；不含冷却/满载判定） */
  activeAccountIds(type: RemoteStorageBackendType): string[] {
    return Array.from(this.runtimes.values())
      .filter((rt) => rt.type === type && rt.enabled && rt.status === 'active')
      .map((rt) => rt.accountId)
      .sort();
  }

  /** 池内是否存在该账号（回源侧判定「归属是否可确认」） */
  hasAccount(accountId: string): boolean {
    return this.runtimes.has(accountId);
  }

  getRuntime(accountId: string): StorageAccountRuntime | undefined {
    return this.runtimes.get(accountId);
  }

  /**
   * 按负载选号。`requiredBytes` 提供时启用 GDrive 配额硬准入；
   * `candidateIds` 限定候选（回源侧只允许对象所属账号）。
   */
  select(
    type: RemoteStorageBackendType,
    now = Date.now(),
    opts?: { requiredBytes?: number; exclude?: Set<string>; candidateIds?: string[] },
  ): StorageSelection | null {
    const candidates = Array.from(this.runtimes.values())
      .filter((rt) => rt.type === type)
      .filter((rt) => !opts?.candidateIds || opts.candidateIds.includes(rt.accountId))
      .filter((rt) => !opts?.exclude?.has(rt.accountId))
      .filter((rt) => this.schedulable(rt, now, opts?.requiredBytes))
      .sort((a, b) => a.accountId.localeCompare(b.accountId));
    if (candidates.length === 0) return null;

    const bestBandwidth = Math.max(
      ...candidates.map((rt) => rt.ewmaBandwidthMbps ?? 0),
      0.001,
    );
    const scored = candidates.map((rt) => {
      const bandwidthScore = rt.ewmaBandwidthMbps === null
        ? NEUTRAL_BANDWIDTH_SCORE
        : Math.min(1, rt.ewmaBandwidthMbps / bestBandwidth);
      const healthScore = Math.min(1, Math.max(0.05, rt.ewmaSuccess));
      const capacityScore = Math.max(0, 1 - rt.inflight / rt.maxInflight);
      const quotaScore = this.quotaScore(rt);
      const score = rt.weight * (0.5 * bandwidthScore + 0.5 * healthScore) * capacityScore * quotaScore;
      return { rt, score };
    });
    const maxScore = Math.max(...scored.map((item) => item.score));
    if (maxScore <= 0) return null;
    const best = scored.filter((item) => item.score >= maxScore - 1e-9);
    const picked = best[this.rotateCursor % best.length];
    this.rotateCursor = (this.rotateCursor + 1) % Math.max(1, best.length);
    return {
      accountId: picked.rt.accountId,
      reason: `score=${picked.score.toFixed(3)}（带宽×健康×容量×配额，候选 ${candidates.length}）`,
    };
  }

  /** 原子准入：占一个在飞名额；冷却/满载/禁用时拒绝 */
  beginAttempt(accountId: string, now = Date.now(), requiredBytes?: number): boolean {
    const rt = this.runtimes.get(accountId);
    if (!rt || !this.schedulable(rt, now, requiredBytes)) return false;
    rt.inflight += 1;
    return true;
  }

  /** 传输结束回报采样：更新带宽 EWMA / 健康度 / 冷却 */
  finishAttempt(accountId: string, sample: StorageAttemptSample, now = Date.now()): void {
    const rt = this.runtimes.get(accountId);
    if (!rt) return;
    rt.inflight = Math.max(0, rt.inflight - 1);
    if (sample.ok) {
      rt.consecutiveFailures = 0;
      rt.cooldownUntil = 0;
      rt.ewmaSuccess = EWMA_ALPHA + (1 - EWMA_ALPHA) * rt.ewmaSuccess;
      if (
        typeof sample.bytes === 'number' && sample.bytes > 0
        && typeof sample.durationMs === 'number' && sample.durationMs > 0
      ) {
        const mbps = (sample.bytes * 8) / (sample.durationMs / 1000) / 1_000_000;
        rt.ewmaBandwidthMbps = rt.ewmaBandwidthMbps === null
          ? mbps
          : EWMA_ALPHA * mbps + (1 - EWMA_ALPHA) * rt.ewmaBandwidthMbps;
      }
      return;
    }
    rt.consecutiveFailures += 1;
    rt.ewmaSuccess = (1 - EWMA_ALPHA) * rt.ewmaSuccess;
    const kind = sample.failureKind ?? 'other';
    const base = COOLDOWN_BASE_MS[kind];
    const backoff = Math.min(COOLDOWN_MAX_MS, base * 2 ** Math.min(6, rt.consecutiveFailures - 1));
    const retryAfterMs = typeof sample.retryAfterSeconds === 'number' && sample.retryAfterSeconds > 0
      ? sample.retryAfterSeconds * 1000
      : 0;
    rt.cooldownUntil = now + Math.min(COOLDOWN_MAX_MS, Math.max(backoff, retryAfterMs));
    this.logger.debug(
      `存储账号 ${accountId.slice(-4)} 进入冷却 ${Math.round((rt.cooldownUntil - now) / 1000)}s（${kind}，连续失败 ${rt.consecutiveFailures}）`,
    );
  }

  /** 未发出远端请求即放弃时归还名额（不计失败） */
  releaseAttempt(accountId: string): void {
    const rt = this.runtimes.get(accountId);
    if (rt) rt.inflight = Math.max(0, rt.inflight - 1);
  }

  /** 配额刷新（驱动 getQuota 成功后调用） */
  updateQuota(accountId: string, quota: StorageQuota, now = Date.now()): void {
    const rt = this.runtimes.get(accountId);
    if (!rt) return;
    rt.quotaTotalBytes = quota.totalBytes;
    rt.quotaUsedBytes = quota.usedBytes;
    rt.quotaCheckedAt = now;
    // 配额刷新发现仍有空间时立即解除 quota 冷却（其它账号删除文件可释放空间）
    if (quota.totalBytes === null || quota.totalBytes - quota.usedBytes > QUOTA_HEADROOM_BYTES) {
      if (rt.cooldownUntil > now && rt.consecutiveFailures > 0) {
        // 只清 quota 类冷却无法从分类回溯，保守做法：有空间即整体解除冷却
        rt.cooldownUntil = 0;
      }
    }
  }

  /** 诊断快照（脱敏：不含凭据，账号 id 只保留末 4 位） */
  snapshot(type?: RemoteStorageBackendType) {
    return Array.from(this.runtimes.values())
      .filter((rt) => !type || rt.type === type)
      .map((rt) => ({
        accountId: rt.accountId,
        type: rt.type,
        enabled: rt.enabled,
        status: rt.status,
        inflight: rt.inflight,
        maxInflight: rt.maxInflight,
        ewmaBandwidthMbps: rt.ewmaBandwidthMbps === null ? null : Number(rt.ewmaBandwidthMbps.toFixed(2)),
        ewmaSuccess: Number(rt.ewmaSuccess.toFixed(3)),
        cooldownRemainingMs: Math.max(0, rt.cooldownUntil - Date.now()),
        quotaTotalBytes: rt.quotaTotalBytes,
        quotaUsedBytes: rt.quotaUsedBytes,
      }));
  }

  private schedulable(rt: StorageAccountRuntime, now: number, requiredBytes?: number): boolean {
    if (!rt.enabled || rt.status !== 'active') return false;
    if (rt.cooldownUntil > now) return false;
    if (rt.inflight >= rt.maxInflight) return false;
    // GDrive 配额硬准入：剩余空间必须容纳本次上传（含安全余量）
    if (rt.type === 'gdrive' && rt.quotaTotalBytes !== null && typeof requiredBytes === 'number' && requiredBytes > 0) {
      const remaining = rt.quotaTotalBytes - rt.quotaUsedBytes;
      if (remaining <= requiredBytes * QUOTA_SIZE_FACTOR + QUOTA_HEADROOM_BYTES) return false;
    }
    return true;
  }

  private quotaScore(rt: StorageAccountRuntime): number {
    if (rt.type !== 'gdrive' || rt.quotaTotalBytes === null) return 1;
    if (rt.quotaCheckedAt === 0) return NEUTRAL_QUOTA_SCORE;
    const remaining = Math.max(0, rt.quotaTotalBytes - rt.quotaUsedBytes);
    return Math.min(1, Math.max(0.05, remaining / rt.quotaTotalBytes));
  }
}