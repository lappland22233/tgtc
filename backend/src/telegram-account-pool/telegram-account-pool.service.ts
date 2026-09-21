import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccountAttemptSample,
  AccountFailureKind,
  AccountPoolCounters,
  AccountPoolCounterKey,
  AccountPoolSnapshot,
  AccountSelection,
  TelegramAccountConfig,
  TelegramAccountRuntime,
} from './telegram-account-pool.types';

/** EWMA 平滑系数（0.3 ≈ 约 3 次采样后逼近真实值） */
const EWMA_ALPHA = 0.3;
/** 未探测过带宽时的中性分（避免新账号被永久压制） */
const NEUTRAL_BANDWIDTH_SCORE = 0.5;
/** 各类失败的冷却基数（毫秒），按连续失败次数指数放大且不超过上限 */
const COOLDOWN_BASE_MS: Record<AccountFailureKind, number> = {
  flood: 60_000,
  unavailable: 30_000,
  timeout: 15_000,
  network: 10_000,
  other: 10_000,
};
const COOLDOWN_MAX_MS = 10 * 60 * 1000;
/** 健康探测间隔（毫秒）：只做 getMe，成本极低 */
const HEALTH_PROBE_INTERVAL_MS = 60_000;
/** 探测失败也计入健康度的失败分类判定阈值 */
const PROBE_FAILURE_KIND: AccountFailureKind = 'network';

/**
 * Bot 账号池：多账号注册表 + 加权负载选择 + 失败冷却 + 在线健康探测。
 *
 * 选择口径（按用户选定方案「加权（带宽 × 健康度）」）：
 * ```
 * 可调度条件： enabled && 未冷却 && inflight < maxInflight
 * 带宽分   = ewmaBandwidth / 池内最优带宽        （未探测 → 0.5 中性值）
 * 健康分   = clamp(ewmaSuccess, 0.05, 1)
 * 容量分   = 1 - inflight / maxInflight          （满载 → 0，天然平滑分流）
 * 得分     = weight × (0.5×带宽分 + 0.5×健康分) × 容量分
 * ```
 * 与实验结论一致：**每账号在飞上限**（默认 8，建议 8–16）比单纯轮询更能压低 stall；
 * 而权重/带宽分让优质线路（如本实验的直连机房）承担更多流量。
 *
 * 该服务只做「选择与记账」，不发请求：实际 HTTP 由 `TelegramAccountClientService` 执行，
 * 完成后由调用方回报采样，避免服务间循环依赖。
 */
@Injectable()
export class TelegramAccountPoolService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TelegramAccountPoolService.name);
  private readonly runtimes = new Map<string, TelegramAccountRuntime>();
  private readonly enabled: boolean;
  private probeTimer: NodeJS.Timeout | null = null;
  /** 平局轮转游标：让得分相同的账号也能被均匀分流（见 select 注释） */
  private rotateCursor = 0;
  /** 进程内计数（选择/换号/回退/复制/回复失败），供诊断与告警判定 */
  private readonly counters: AccountPoolCounters = {
    selections: 0,
    failovers: 0,
    fallbacks: 0,
    unresolved: 0,
    replicationsOk: 0,
    replicationsFailed: 0,
    streamFailures: 0,
    replyFailures: 0,
    inboundRegistrationFailures: 0,
  };

  /** 供健康探测注入：`(id) => Promise<void>`；由模块装配阶段设置，避免循环依赖 */
  private probeFn: ((accountId: string) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>) | null = null;

  constructor(private readonly configService: ConfigService) {
    this.enabled = (this.configService.get<string>('TELEGRAM_ACCOUNT_POOL_ENABLED') || '')
      .trim()
      .toLowerCase() === 'true';

    for (const config of this.loadConfigs()) {
      this.runtimes.set(config.id, this.createRuntime(config));
    }

    if (this.enabled) {
      if (this.runtimes.size === 0) {
        // 启用但没配账号 → 明确告警并自动退化到单账号链路（fail-open，不阻断业务）
        this.logger.warn(
          'TELEGRAM_ACCOUNT_POOL_ENABLED=true 但未解析到任何账号'
          + '（请配置 TELEGRAM_ACCOUNT_POOL 或 TELEGRAM_BOT_TOKENS）——本次运行将回退单账号链路',
        );
      } else {
        this.logger.log(
          `Bot 账号池已启用：${this.runtimes.size} 个账号（${this.ids().join(', ')}）`,
        );
      }
    }
  }

  /** 是否处于"可用的池化模式"（启用 + 至少一个账号） */
  isActive(): boolean {
    return this.enabled && this.runtimes.size > 0;
  }

  /**
   * 未生效原因（`isActive()=false` 时可诊断）。
   * 用于区分「服务健康」与「账号池已启用但未生效（配置缺失/非法）」。
   */
  inactiveReason(): string | null {
    if (!this.enabled) return 'TELEGRAM_ACCOUNT_POOL_ENABLED 未显式设为 true';
    if (this.runtimes.size === 0) {
      return '未解析到任何账号（TELEGRAM_ACCOUNT_POOL / TELEGRAM_BOT_TOKENS 为空或非法）';
    }
    return null;
  }

  /** 计数（进程内，单实例语义） */
  bumpCounter(key: AccountPoolCounterKey, delta = 1): void {
    this.counters[key] += delta;
  }

  countersSnapshot(): AccountPoolCounters {
    return { ...this.counters };
  }

  ids(): string[] {
    return Array.from(this.runtimes.keys());
  }

  getConfig(accountId: string): TelegramAccountConfig | null {
    return this.runtimes.get(accountId)?.config ?? null;
  }

  /** 注册健康探测函数（由模块装配调用；避免构造期循环依赖） */
  registerProbe(fn: (accountId: string) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>): void {
    this.probeFn = fn;
  }

  async onModuleInit(): Promise<void> {
    if (!this.isActive()) return;
    // 启动即探测一轮，避免"新账号未探测 → 中性分"长时间误导选择
    void this.probeAll();
    this.probeTimer = setInterval(() => void this.probeAll(), HEALTH_PROBE_INTERVAL_MS);
    this.probeTimer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  // ---------------- 配置解析 ----------------

  /**
   * 解析账号配置，优先级：
   * 1. `TELEGRAM_ACCOUNT_POOL`（JSON 数组，字段见 TelegramAccountConfig，可含 note/weight/maxInflight，推荐）；
   * 2. `TELEGRAM_BOT_TOKENS`（逗号分隔 token 列表）+ `TELEGRAM_CHAT_ID`（上传存储 Chat）作为 chat；
   *    注意：`TELEGRAM_ARCHIVE_CHAT_ID` 只用于审计转发，**不得**充当隐式存储目标；
   * 3. 兜底：`TELEGRAM_BOT_TOKEN` 单账号（仅当启用池化时用于兼容，等价于池内唯一账号）。
   */
  private loadConfigs(): TelegramAccountConfig[] {
    const raw = (this.configService.get<string>('TELEGRAM_ACCOUNT_POOL') || '').trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        const list = Array.isArray(parsed) ? parsed : [];
        const configs = list
          .map((item) => this.normalizeConfig(item as Record<string, unknown>))
          .filter((item): item is TelegramAccountConfig => item !== null);
        if (configs.length > 0) return this.dedupe(configs);
        this.logger.warn('TELEGRAM_ACCOUNT_POOL 解析后为空，尝试 TELEGRAM_BOT_TOKENS');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`TELEGRAM_ACCOUNT_POOL 不是合法 JSON，已忽略：${message}`);
      }
    }

    const tokens = (this.configService.get<string>('TELEGRAM_BOT_TOKENS') || '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (tokens.length > 0) {
      // 兼容输入只允许复用「上传存储 Chat」（TELEGRAM_CHAT_ID）。
      // **归档群（TELEGRAM_ARCHIVE_CHAT_ID）不得充当隐式存储目标**：它只用于审计转发，
      // 把副本上传进归档群会混淆审计流与存储流（硬约束：每账号的存储 Chat 必须显式确认）。
      const chatId = (this.configService.get<string>('TELEGRAM_CHAT_ID') || '').trim();
      const configs = tokens.map((token, index) => this.normalizeConfig({
        id: `bot${index + 1}`,
        token,
        chatId,
      })).filter((item): item is TelegramAccountConfig => item !== null);
      if (configs.length > 0) return this.dedupe(configs);
    }

    if (this.enabled) {
      const single = (this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '').trim();
      const chatId = (this.configService.get<string>('TELEGRAM_CHAT_ID') || '').trim();
      if (single && chatId) {
        const config = this.normalizeConfig({ token: single, chatId });
        if (config) return [config];
      }
    }
    return [];
  }

  private normalizeConfig(raw: Record<string, unknown>): TelegramAccountConfig | null {
    const token = String(raw.token ?? '').trim();
    if (!token || !token.includes(':')) return null;
    const chatId = String(raw.chatId ?? raw.chat_id ?? '').trim();
    const botId = token.split(':')[0];
    const weightRaw = Number(raw.weight);
    const maxInflightRaw = Number(raw.maxInflight ?? raw.max_inflight);
    return {
      id: String(raw.id ?? botId).trim() || botId,
      token,
      chatId,
      weight: Number.isFinite(weightRaw) && weightRaw > 0 ? weightRaw : 1,
      maxInflight: Number.isSafeInteger(maxInflightRaw) && maxInflightRaw > 0 ? maxInflightRaw : 8,
      enabled: raw.enabled === undefined ? true : raw.enabled !== false,
      // note 为运维自由文本，仅用于报告/排障：去控制字符并截断；
      // 约定**不得填写敏感信息**（该字段会出现在只读诊断快照中）。
      note: raw.note === undefined
        ? undefined
        : String(raw.note).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 120) || undefined,
    };
  }

  /** 按 id 去重（保留首次出现），避免配置重复导致重复分流 */
  private dedupe(configs: TelegramAccountConfig[]): TelegramAccountConfig[] {
    const seen = new Set<string>();
    const out: TelegramAccountConfig[] = [];
    for (const config of configs) {
      if (seen.has(config.id)) {
        this.logger.warn(`账号 id 重复，已忽略后者：${config.id}`);
        continue;
      }
      seen.add(config.id);
      out.push(config);
    }
    return out;
  }

  private createRuntime(config: TelegramAccountConfig): TelegramAccountRuntime {
    return {
      config,
      inflight: 0,
      bandwidthEwmaBps: 0,
      successEwma: 1,
      latencyEwmaMs: 0,
      consecutiveFailures: 0,
      cooldownUntilMs: 0,
      totalBytes: 0,
      totalRequests: 0,
      failures: 0,
      lastErrorKind: null,
      lastErrorAtMs: 0,
      lastSuccessAtMs: 0,
    };
  }

  // ---------------- 选择 ----------------

  /**
   * 按加权得分选择一个账号。
   *
   * 平局处理：候选集按游标**轮转起点**，使得得分相同的账号（例如三个配置完全一致的空闲账号）
   * 也会被均匀分流——否则「严格大于才替换」会让全部流量落到第一个账号，突发压测时严重失真。
   *
   * @param candidateIds 限定候选（例如「持有该文件副本的账号」）；为空表示全池
   */
  select(candidateIds?: string[], nowMs: number = Date.now()): AccountSelection | null {
    // 开关兜底（防御纵深）：未启用池化时任何路径都不得选中账号，
    // 保证「关闭开关 = 原单账号行为」不依赖调用方是否记得检查 isActive()。
    if (!this.enabled) return null;

    const schedulable = (candidateIds && candidateIds.length > 0
      ? candidateIds.map((id) => this.runtimes.get(id)).filter((item): item is TelegramAccountRuntime => Boolean(item))
      : Array.from(this.runtimes.values()))
      .filter((runtime) => this.isSchedulable(runtime, nowMs));

    if (schedulable.length === 0) return null;
    this.rotateCursor = (this.rotateCursor + 1) % Math.max(1, schedulable.length);
    const candidates = [
      ...schedulable.slice(this.rotateCursor),
      ...schedulable.slice(0, this.rotateCursor),
    ];

    const bestBandwidth = candidates.reduce(
      (max, runtime) => Math.max(max, runtime.bandwidthEwmaBps),
      0,
    );

    let best: AccountSelection | null = null;
    for (const runtime of candidates) {
      const bandwidthScore = bestBandwidth > 0
        ? runtime.bandwidthEwmaBps / bestBandwidth
        : NEUTRAL_BANDWIDTH_SCORE;
      const healthScore = Math.min(1, Math.max(0.05, runtime.successEwma));
      const capacityScore = Math.max(0, 1 - runtime.inflight / runtime.config.maxInflight);
      const score = runtime.config.weight * (0.5 * bandwidthScore + 0.5 * healthScore) * capacityScore;
      const reason = `bw=${(runtime.bandwidthEwmaBps / 1024 / 1024).toFixed(2)}MB/s `
        + `health=${healthScore.toFixed(2)} inflight=${runtime.inflight}/${runtime.config.maxInflight} `
        + `weight=${runtime.config.weight}`;
      if (!best || score > best.score) {
        best = { accountId: runtime.config.id, score, reason };
      }
    }
    return best;
  }

  private isSchedulable(runtime: TelegramAccountRuntime, nowMs: number): boolean {
    if (!runtime.config.enabled) return false;
    if (runtime.inflight >= runtime.config.maxInflight) return false;
    return runtime.cooldownUntilMs <= nowMs;
  }

  // ---------------- 记账 ----------------

  /** 请求开始：占用一个在飞额度（调用方必须保证 finally 中 release） */
  beginAttempt(accountId: string): boolean {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) return false;
    runtime.inflight += 1;
    return true;
  }

  /** 仅释放在飞额度（未产生可用样本时使用，如客户端主动取消） */
  releaseAttempt(accountId: string): void {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) return;
    runtime.inflight = Math.max(0, runtime.inflight - 1);
  }

  /** 请求结束：释放额度 + 更新带宽/健康 EWMA + 必要时进入冷却 */
  finishAttempt(accountId: string, sample: AccountAttemptSample): void {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) return;
    runtime.inflight = Math.max(0, runtime.inflight - 1);
    runtime.totalRequests += 1;
    const now = Date.now();

    if (sample.ok) {
      runtime.successEwma = (1 - EWMA_ALPHA) * runtime.successEwma + EWMA_ALPHA * 1;
      runtime.consecutiveFailures = 0;
      runtime.lastSuccessAtMs = now;
      if (sample.bytes && sample.bytes > 0 && sample.durationMs && sample.durationMs > 0) {
        const bps = sample.bytes / (sample.durationMs / 1000);
        runtime.bandwidthEwmaBps = runtime.bandwidthEwmaBps > 0
          ? (1 - EWMA_ALPHA) * runtime.bandwidthEwmaBps + EWMA_ALPHA * bps
          : bps;
        runtime.totalBytes += sample.bytes;
      }
      return;
    }

    const kind: AccountFailureKind = sample.failureKind ?? 'other';
    runtime.successEwma = (1 - EWMA_ALPHA) * runtime.successEwma;
    runtime.consecutiveFailures += 1;
    runtime.failures += 1;
    runtime.lastErrorKind = kind;
    runtime.lastErrorAtMs = now;
    const baseMs = COOLDOWN_BASE_MS[kind] ?? COOLDOWN_BASE_MS.other;
    const escalated = Math.min(baseMs * 2 ** (runtime.consecutiveFailures - 1), COOLDOWN_MAX_MS);
    const retryAfterMs = sample.retryAfterSeconds && sample.retryAfterSeconds > 0
      ? sample.retryAfterSeconds * 1000
      : 0;
    runtime.cooldownUntilMs = now + Math.max(escalated, retryAfterMs);
    this.logger.warn(
      `账号 ${accountId} 失败（${kind}${sample.status ? `/${sample.status}` : ''}），冷却 `
      + `${(Math.max(escalated, retryAfterMs) / 1000).toFixed(0)}s`
      + (sample.errorMessage ? `：${sample.errorMessage.slice(0, 200)}` : ''),
    );
  }

  /** 健康探测：只更新延迟/健康，不改变带宽（探测流量太小，不能代表真实吞吐） */
  recordProbe(accountId: string, ok: boolean, latencyMs?: number, error?: string): void {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) return;
    if (ok) {
      runtime.successEwma = (1 - EWMA_ALPHA) * runtime.successEwma + EWMA_ALPHA * 1;
      runtime.consecutiveFailures = 0;
      runtime.lastSuccessAtMs = Date.now();
      if (latencyMs && latencyMs > 0) {
        runtime.latencyEwmaMs = runtime.latencyEwmaMs > 0
          ? (1 - EWMA_ALPHA) * runtime.latencyEwmaMs + EWMA_ALPHA * latencyMs
          : latencyMs;
      }
      return;
    }
    const kind: AccountFailureKind = PROBE_FAILURE_KIND;
    runtime.successEwma = (1 - EWMA_ALPHA) * runtime.successEwma;
    runtime.consecutiveFailures += 1;
    runtime.failures += 1;
    runtime.lastErrorKind = kind;
    runtime.lastErrorAtMs = Date.now();
    const escalated = Math.min(COOLDOWN_BASE_MS[kind] * 2 ** (runtime.consecutiveFailures - 1), COOLDOWN_MAX_MS);
    runtime.cooldownUntilMs = Date.now() + escalated;
    if (error) {
      this.logger.warn(`账号 ${accountId} 健康探测失败：${error.slice(0, 200)}`);
    }
  }

  private async probeAll(): Promise<void> {
    if (!this.probeFn) return;
    for (const accountId of this.ids()) {
      try {
        const result = await this.probeFn(accountId);
        this.recordProbe(accountId, result.ok, result.latencyMs, result.error);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.recordProbe(accountId, false, undefined, message);
      }
    }
  }

  // ---------------- 观测 ----------------

  snapshot(): AccountPoolSnapshot {
    return {
      enabled: this.isActive(),
      inactiveReason: this.inactiveReason(),
      counters: this.countersSnapshot(),
      accounts: Array.from(this.runtimes.values()).map((runtime) => {
        const now = Date.now();
        return {
          id: runtime.config.id,
          tokenPreview: this.tokenPreview(runtime.config.token),
          chatId: runtime.config.chatId,
          enabled: runtime.config.enabled,
          weight: runtime.config.weight,
          maxInflight: runtime.config.maxInflight,
          inflight: runtime.inflight,
          bandwidthMbps: Number((runtime.bandwidthEwmaBps / 1024 / 1024).toFixed(3)),
          successRate: Number(runtime.successEwma.toFixed(4)),
          latencyMs: Math.round(runtime.latencyEwmaMs),
          coolingDown: runtime.cooldownUntilMs > now,
          cooldownRemainingMs: Math.max(0, runtime.cooldownUntilMs - now),
          consecutiveFailures: runtime.consecutiveFailures,
          totalRequests: runtime.totalRequests,
          failures: runtime.failures,
          totalBytes: runtime.totalBytes,
          lastErrorKind: runtime.lastErrorKind,
          note: runtime.config.note,
        };
      }),
    };
  }

  /**
   * token 展示前缀（botId + 前若干位），任何对外输出都用它，禁止完整 token。
   * 防御性处理：短 secret（异常配置）时只暴露 1/3 且至少保留 4 位掩码，
   * 避免「预览等于明文」。
   */
  private tokenPreview(token: string): string {
    const [botId, secret = ''] = token.split(':');
    const shown = Math.max(1, Math.min(6, Math.floor(secret.length / 3), secret.length - 4));
    return `${botId}:${secret.slice(0, shown)}***`;
  }
}
