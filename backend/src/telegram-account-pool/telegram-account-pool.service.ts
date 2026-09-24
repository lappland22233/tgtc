import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccountAdmissionRequest,
  AccountAdmissionResult,
  AccountAttemptAdmission,
  AccountAttemptRole,
  AccountAttemptSample,
  AccountFailureKind,
  AccountPoolAccountSnapshot,
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

/** 大文件阈值（字节）：超过即占用「每账号大文件回源槽位」（与资源协调器的权重口径一致） */
const LARGE_FILE_THRESHOLD_BYTES = 1024 ** 3;
/** 每账号大文件回源槽位默认值（未显式配置时）：同一账号同时只跑 1 个大文件冷回源 */
const LARGE_INFLIGHT_DEFAULT = 1;
/**
 * 每账号复制（副本扩散）并发上限。
 *
 * 复制与下载共享同一账号的上游额度，且复制本身就是「用下载带宽换副本分布」，
 * 因此按 1 严格限制：任何时刻同一账号最多一条复制流，且它必须先通过
 * `admit({role:'replication'})`——下载优先由调用方在准入前判断系统负载。
 */
const REPLICATION_INFLIGHT_MAX = 1;
/** 准入被拒（非冷却）时的建议重试间隔（毫秒） */
const ADMISSION_RETRY_AFTER_MS = 5_000;

/** 是否为大文件（非有限值/非正数按小文件处理，避免误占用大文件槽位） */
function isLargeFileBytes(bytes?: number): boolean {
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > LARGE_FILE_THRESHOLD_BYTES;
}

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
    userRelaysOk: 0,
    userRelaysFailed: 0,
    relayClaimsMissed: 0,
    inboundBridgeMisses: 0,
    anchorConflicts: 0,
    fallbackThrottled: 0,
    largeFileSlotThrottled: 0,
  };

  /** 供健康探测注入：`(id) => Promise<void>`；由模块装配阶段设置，避免循环依赖 */
  private probeFn: ((accountId: string) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>) | null = null;

  /**
   * 「账号池由未生效变为生效」时的补装回调（由模块装配阶段注册）。
   *
   * 为什么需要：模块级后台任务（运行态告警采集、副本记录清理）若只在启动时按
   * `isActive()` 判断一次，就会在「env 默认关闭 + 后台热开启」这条推荐部署路径上
   * 永不启动——表现为「账号池看着在跑，但告警静默、副本记录表无界增长」，
   * 与「共享状态只在其中一条分支初始化」属同一类静默失效。
   */
  private readonly activeHooks: Array<() => void> = [];

  /**
   * 上次对外可见的生效状态。
   *
   * 为什么需要：`refreshExternalAccounts()` 会被周期调用（面板账号同步），
   * 若每次刷新都广播回调，回调里的重活（定时器装配、账号就绪检查）会被高频重复执行；
   * 因此只把 `false → true` 的**跃迁**当作一次热开启事件上报。
   */
  private lastActiveState = false;

  /**
   * 面板（数据库）账号来源，由账号管理模块在装配阶段注册。
   *
   * 为什么用注册回调而不是直接 import 账号管理模块：账号管理模块需要本服务做
   * 连通性探测（`TelegramAccountClientService`），直接互相 import 会形成模块环。
   */
  private externalAccountSource: (() => Promise<TelegramAccountConfig[]>) | null = null;

  /**
   * 运行时开关（来自 `SystemConfig` 的面板热切换）。
   * `null` 表示尚未同步，沿用环境变量的引导值；同步后以面板值为准。
   */
  private runtimeEnabled: boolean | null = null;

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
        // 无存储 Chat 的账号只能参与下载回源，不能被选为上传/镜像目标。
        // 这类配置在池化模式下会表现为「上传全部回退单账号」，必须显式提示而不是静默降级。
        const noStorage = Array.from(this.runtimes.values())
          .filter((runtime) => !runtime.config.chatId)
          .map((runtime) => runtime.config.id);
        if (noStorage.length === this.runtimes.size) {
          this.logger.warn(
            `账号池内没有任何账号配置存储 Chat（${noStorage.join(', ')}）：`
            + '上传与镜像将回退单账号链路（每账号的存储 Chat 必须显式确认）',
          );
        } else if (noStorage.length > 0) {
          this.logger.warn(
            `以下账号未配置存储 Chat，仅参与下载回源、不会被选为上传/镜像目标：${noStorage.join(', ')}`,
          );
        }
      }
    }
  }

  /** 当前生效的开关值（面板运行时值优先，未同步时用环境变量引导值） */
  effectiveEnabled(): boolean {
    return this.runtimeEnabled ?? this.enabled;
  }

  /** 是否处于"可用的池化模式"（启用 + 至少一个账号） */
  isActive(): boolean {
    return this.effectiveEnabled() && this.runtimes.size > 0;
  }

  /**
   * 未生效原因（`isActive()=false` 时可诊断）。
   * 用于区分「服务健康」与「账号池已启用但未生效（配置缺失/非法）」。
   */
  inactiveReason(): string | null {
    if (!this.effectiveEnabled()) {
      return this.runtimeEnabled === null
        ? 'TELEGRAM_ACCOUNT_POOL_ENABLED 未显式设为 true'
        : '账号池总开关已关闭（后台运行时配置）';
    }
    if (this.runtimes.size === 0) {
      return '未解析到任何账号（TELEGRAM_ACCOUNT_POOL / TELEGRAM_BOT_TOKENS 为空，且后台未启用任何账号）';
    }
    return null;
  }

  /**
   * 注册面板账号来源（由账号管理模块装配阶段调用）。
   * 来源必须**已解密**凭据且只返回可用账号（禁用/撤销/待授权的账号不得出现在结果中）。
   */
  registerAccountSource(fn: () => Promise<TelegramAccountConfig[]>): void {
    this.externalAccountSource = fn;
  }

  /**
   * 刷新面板账号与运行时开关（幂等，可反复调用）。
   *
   * 语义：
   * - **只替换 `source='panel'` 的账号**，env 引导账号（source='env'）保持不变；
   * - 已存在的面板账号保留运行期画像（健康/带宽/冷却），只更新静态配置；
   * - 面板中已删除/停用的账号被移除，不再参与调度（在途请求由调用方自然收尾）；
   * - 运行时开关立即生效：关闭只阻止新任务（`isActive()=false`），不中断已开始的流。
   */
  async refreshExternalAccounts(runtimeEnabled: boolean | null): Promise<void> {
    this.runtimeEnabled = runtimeEnabled;
    // 开关本身就可能让 isActive() 变为 true（env 已配账号、面板刚开启）：
    // 必须在下面的两处早退之前补装，否则热开启的定时器与探针永远补不上
    this.applyRuntimeReadiness();
    if (!this.externalAccountSource) return;

    let configs: TelegramAccountConfig[];
    try {
      configs = await this.externalAccountSource();
    } catch (error) {
      // 面板账号刷新失败不影响 env 账号与既有调度；下轮重试
      this.logger.warn(
        `面板账号刷新失败（保留现有账号继续调度）：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    // 环境变量账号（含主 Bot）优先：同一 Token 的面板账号必须被丢弃，
    // 否则同一 Bot 会以两个 id 同时出现在池内 —— 双重轮询、双重计数、双重任务。
    const envTokens = new Set(
      Array.from(this.runtimes.values())
        .filter((runtime) => runtime.config.source !== 'panel')
        .map((runtime) => runtime.config.token),
    );
    const duplicated = configs.filter((config) => envTokens.has(config.token)).map((config) => config.id);
    if (duplicated.length > 0) {
      this.logger.warn(
        `面板账号与环境变量账号 Token 相同，已跳过（环境变量优先）：${duplicated.join(', ')}`,
      );
    }

    const incoming = new Map(
      configs
        .filter((config) => !envTokens.has(config.token))
        .map((config) => [config.id, { ...config, source: 'panel' as const, primary: undefined }]),
    );
    const removed: string[] = [];
    for (const [id, runtime] of this.runtimes.entries()) {
      if (runtime.config.source !== 'panel') continue;
      if (!incoming.has(id)) {
        this.runtimes.delete(id);
        removed.push(id);
      }
    }

    const added: string[] = [];
    for (const [id, config] of incoming.entries()) {
      const existing = this.runtimes.get(id);
      if (existing) {
        // 防御纵深：环境变量账号绝不被面板账号覆盖（即使 id 相同）
        if (existing.config.source !== 'panel') {
          this.logger.warn(`面板账号 id 与环境变量账号冲突，已保留环境变量账号：${id}`);
          continue;
        }
        // 保留运行期画像（冷却/带宽/成功率/在飞计数），只更新静态配置
        existing.config = { ...existing.config, ...config };
      } else {
        this.runtimes.set(id, this.createRuntime(config));
        added.push(id);
      }
    }

    if (added.length > 0 || removed.length > 0) {
      this.logger.log(
        `面板账号已同步：新增 ${added.length} 个${added.length ? `（${added.join(', ')}）` : ''}`
        + `，移除 ${removed.length} 个${removed.length ? `（${removed.join(', ')}）` : ''}`,
      );
    }

    // 新账号立即探测一轮，避免「未探测 → 中性分」长时间误导选择
    if (added.length > 0 && this.effectiveEnabled() && this.probeFn) {
      for (const id of added) {
        void this.probeFn(id).then((result) => this.recordProbe(id, result.ok, result.latencyMs, result.error));
      }
    }
    // 账号集合变化后再次补装：新增账号也可能让 isActive() 由 false 变 true
    // （幂等：探针定时器与生效跃迁回调都不会重复启动）
    this.applyRuntimeReadiness();
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

  /**
   * 可作为**上传/镜像目标**的账号（已启用且配置了存储 Chat）。
   *
   * 为什么必须单独一个集合：没有存储 Chat 的账号上传必然失败，
   * 若进入上传候选集，会表现为「池化上传持续换号后回退单账号」，掩盖真实配置缺失。
   */
  storageAccountIds(): string[] {
    return Array.from(this.runtimes.values())
      .filter((runtime) => runtime.config.enabled && Boolean(runtime.config.chatId))
      .map((runtime) => runtime.config.id);
  }

  getConfig(accountId: string): TelegramAccountConfig | null {
    return this.runtimes.get(accountId)?.config ?? null;
  }

  /**
   * 该 Token 是否已在账号池注册（含环境变量主 Bot）。
   *
   * 用途：Token 级去重。同一 Bot 只允许存在一个逻辑账号，
   * 否则会双重轮询、双重计数、双重执行任务。
   */
  isTokenRegistered(token: string): boolean {
    return this.findByToken(token) !== null;
  }

  /**
   * 该 Token 是否由**环境变量**注册（主 Bot 或 `TELEGRAM_ACCOUNT_POOL` / `TELEGRAM_BOT_TOKENS`）。
   *
   * 用途：后台创建 Bot 账号前拒绝与环境变量账号重复的 Token。
   * 环境变量是密钥管理边界：这类账号后台只读，不允许再以数据库账号形式重复承载。
   */
  isEnvTokenRegistered(token: string): boolean {
    const runtime = this.findByToken(token);
    return runtime !== null && runtime.config.source !== 'panel';
  }

  /**
   * 该账号 id 是否由**环境变量**注册（主 Bot 或 `TELEGRAM_ACCOUNT_POOL` / `TELEGRAM_BOT_TOKENS`）。
   *
   * 用途：后台把「同一 Bot 既在数据库又被环境变量注册」标记为双来源（`both`），
   * 提示管理员该账号的密钥以 `.env` 为准、后台不应重复维护。
   */
  isEnvAccount(accountId: string): boolean {
    const runtime = this.runtimes.get((accountId || '').trim());
    return runtime !== undefined && runtime.config.source !== 'panel';
  }

  private findByToken(token: string): TelegramAccountRuntime | null {
    const normalized = (token || '').trim();
    if (!normalized) return null;
    for (const runtime of this.runtimes.values()) {
      if (runtime.config.token === normalized) return runtime;
    }
    return null;
  }

  /** 环境变量主 Bot 的账号 id（未配置 `TELEGRAM_BOT_TOKEN` 时为 null） */
  primaryAccountId(): string | null {
    for (const runtime of this.runtimes.values()) {
      if (runtime.config.primary) return runtime.config.id;
    }
    return null;
  }

  /** 注册健康探测函数（由模块装配调用；避免构造期循环依赖） */
  registerProbe(fn: (accountId: string) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>): void {
    this.probeFn = fn;
  }

  /**
   * 注册「账号池变为生效」时的补装回调（由模块装配阶段调用）。
   *
   * 幂等：同一函数重复注册只保留一份，避免装配顺序变化或多处注册导致回调叠加
   * （补装回调里含定时器装配与账号校验，重复执行会放大副作用）。
   *
   * 与 `registerProbe` 同属「装配期注入、避免模块环」的解耦手法：账号池服务
   * 不能反向依赖模块，但模块级定时器需要在热开启时被唤醒。
   */
  registerActiveHook(fn: () => void): void {
    if (this.activeHooks.includes(fn)) return;
    this.activeHooks.push(fn);
  }

  async onModuleInit(): Promise<void> {
    this.applyRuntimeReadiness();
  }

  /**
   * 运行时就绪状态变化后的统一补装入口（幂等）。
   *
   * 为什么必须在 `refreshExternalAccounts()` 的**两处早退之前**也调用一次：
   * `isActive()` 的两个因子都可能在这个方法里由 false 变 true
   * （`runtimeEnabled` 同步、账号集合变化），一旦早退就会跳过
   * 「周期健康探测」与「模块级定时器」的补装。
   */
  private applyRuntimeReadiness(): void {
    this.ensureProbeTimer();
    this.notifyActiveTransition();
  }

  /**
   * 广播「由未生效变为生效」的跃迁（只在跃迁上触发，见 `lastActiveState` 注释）。
   *
   * 回调异常只告警不抛出：补装失败不该影响账号池本身的调度能力。
   */
  private notifyActiveTransition(): void {
    const active = this.isActive();
    if (active === this.lastActiveState) return;
    this.lastActiveState = active;
    if (!active) return;
    for (const hook of this.activeHooks) {
      try {
        hook();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`账号池生效回调执行失败（忽略）: ${message}`);
      }
    }
  }

  /**
   * 确保健康探测定时器在「池化真正可用」时运行。
   *
   * 为什么不能只在 onModuleInit 判断一次：`env 关闭 → 后台热开启` 是推荐路径，
   * 启动时 `isActive()=false` 会永久跳过定时探测，账号健康度只能靠"新增时探一次"，
   * 冷却恢复与在线状态识别都会失准。这里做成幂等的"按需启动"。
   */
  private ensureProbeTimer(): void {
    if (!this.isActive()) return;
    if (this.probeTimer) return;
    // 启动即探测一轮，避免"未探测 → 中性分"长时间误导选择
    void this.probeAll();
    this.probeTimer = setInterval(() => void this.probeAll(), HEALTH_PROBE_INTERVAL_MS);
    this.probeTimer.unref?.();
    this.logger.log(`账号池健康探测已启动：每 ${HEALTH_PROBE_INTERVAL_MS / 1000}s 一次`);
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
   * 3. **始终**并入 `TELEGRAM_BOT_TOKEN` 主 Bot（标记 `primary: true`，后台只读；同 Token 不重复注册）。
   */
  private loadConfigs(): TelegramAccountConfig[] {
    return this.withPrimaryBot(this.loadExplicitConfigs());
  }

  /** 显式配置的账号（不含环境变量主 Bot 的兜底注册） */
  private loadExplicitConfigs(): TelegramAccountConfig[] {
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

    return [];
  }

  /**
   * 始终把「环境变量主 Bot」（`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`）并入账号注册表。
   *
   * 为什么必须始终注册（而不是只在池化启用时兜底）：
   * - 后台账号池页面要展示主 Bot 的来源/健康/负载，否则管理员无法确认「账号池是否真的生效」；
   * - 池化模式下的入站轮询按 `ids()` 逐账号进行，主 Bot 不在册会导致它的私聊消息无人消费；
   * - 主 Bot 是 `file_id` 归属的天然锚点：注册 id 取 Token 数字前缀，与
   *   `FileService.defaultBotAccountId()` 完全一致，便于副本与定位字段对齐。
   *
   * 去重规则（防双重轮询/双重计数）：显式配置里已有同一 Token 时，只给它打 `primary` 标记，
   * 不重复注册；若主 Bot 的默认 id 已被「不同 Token」的账号占用，则保留既有账号并告警。
   *
   * 注意：本方法**不改变** `isActive()` 语义（仍为「开关开启 + 注册账号数大于 0」）。
   * 关闭开关时注册表里有主 Bot 也不会进入池化模式，`select()` 依然返回 null。
   */
  private withPrimaryBot(configs: TelegramAccountConfig[]): TelegramAccountConfig[] {
    const token = (this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '').trim();
    if (!token || !token.includes(':')) return configs;

    const existingByToken = configs.find((config) => config.token === token);
    if (existingByToken) {
      existingByToken.primary = true;
      return configs;
    }

    const primary = this.normalizeConfig({
      token,
      chatId: (this.configService.get<string>('TELEGRAM_CHAT_ID') || '').trim(),
      primary: true,
    });
    if (!primary) return configs;

    if (configs.some((config) => config.id === primary.id)) {
      this.logger.warn(
        `环境变量主 Bot（${primary.id}）与已配置账号 id 冲突且 Token 不同，已保留既有账号：`
        + '请检查 TELEGRAM_ACCOUNT_POOL 中的 id 配置',
      );
      return configs;
    }
    return [...configs, primary];
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
      maxLargeInflight: Number.isSafeInteger(Number(raw.maxLargeInflight ?? raw.max_large_inflight))
        && Number(raw.maxLargeInflight ?? raw.max_large_inflight) > 0
        ? Number(raw.maxLargeInflight ?? raw.max_large_inflight)
        : undefined,
      enabled: raw.enabled === undefined ? true : raw.enabled !== false,
      // note 为运维自由文本，仅用于报告/排障：去控制字符并截断；
      // 约定**不得填写敏感信息**（该字段会出现在只读诊断快照中）。
      note: raw.note === undefined
        ? undefined
        : String(raw.note).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 120) || undefined,
      source: 'env',
      primary: raw.primary === true ? true : undefined,
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
      largeInflight: 0,
      replicationInflight: 0,
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
   * @param options.largeFile 本次回源是否为大文件（>1GiB）：为 true 时把
   *   「已达每账号大文件槽位」的账号排除在候选之外，避免选出一个立刻会被准入拒绝的账号；
   *   同时把大文件在飞数与复制在飞数计入容量分，使多账号下的分流更均匀。
   * @param options.role 用途：复制（replication）时把「已有复制流」的账号降权
   *   （下载优先：复制不与下载争抢同一账号的瞬时额度）。
   */
  select(
    candidateIds?: string[],
    nowMs: number = Date.now(),
    options?: { largeFile?: boolean; role?: AccountAttemptRole },
  ): AccountSelection | null {
    // 开关兜底（防御纵深）：未启用池化时任何路径都不得选中账号，
    // 保证「关闭开关 = 原单账号行为」不依赖调用方是否记得检查 isActive()。
    //
    // 必须用 `effectiveEnabled()`（运行时值优先）而不是构造期固化的 `this.enabled`：
    // 「env 默认关闭 + 后台热开启」是推荐部署路径，若此处读 env 值会导致
    // isActive()=true 但选号恒为 null —— 池化静默失效（有账号、永远选不中）。
    if (!this.effectiveEnabled()) return null;

    const schedulable = (candidateIds && candidateIds.length > 0
      ? candidateIds.map((id) => this.runtimes.get(id)).filter((item): item is TelegramAccountRuntime => Boolean(item))
      : Array.from(this.runtimes.values()))
      .filter((runtime) => this.isSchedulable(runtime, nowMs, options));

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
      // 大文件槽位的额外容量惩罚：已占用大文件槽位的账号在同分时排在后面，
      // 使「多账号各有副本」的文件天然把两个大流分到不同账号，而不是都压到带宽最高的那个。
      const largePenalty = options?.largeFile
        ? Math.max(0, 1 - runtime.largeInflight / this.maxLargeInflightOf(runtime))
        : 1;
      const score = runtime.config.weight
        * (0.5 * bandwidthScore + 0.5 * healthScore)
        * capacityScore
        * (0.5 + 0.5 * largePenalty);
      const reason = `bw=${(runtime.bandwidthEwmaBps / 1024 / 1024).toFixed(2)}MB/s `
        + `health=${healthScore.toFixed(2)} inflight=${runtime.inflight}/${runtime.config.maxInflight} `
        + `large=${runtime.largeInflight}/${this.maxLargeInflightOf(runtime)} `
        + `replication=${runtime.replicationInflight} weight=${runtime.config.weight}`;
      if (!best || score > best.score) {
        best = { accountId: runtime.config.id, score, reason };
      }
    }
    return best;
  }

  private isSchedulable(
    runtime: TelegramAccountRuntime,
    nowMs: number,
    options?: { largeFile?: boolean; role?: AccountAttemptRole },
  ): boolean {
    if (!runtime.config.enabled) return false;
    if (runtime.inflight >= runtime.config.maxInflight) return false;
    if (runtime.cooldownUntilMs > nowMs) return false;
    // 大文件回源：已达每账号槽位的账号不再作为候选（否则会被 admit 立刻拒绝，白白消耗一次尝试）
    if (options?.largeFile && runtime.largeInflight >= this.maxLargeInflightOf(runtime)) return false;
    // 复制：同一账号已有复制流时不再被选为复制源/目标（下载优先）
    if (options?.role === 'replication' && runtime.replicationInflight >= REPLICATION_INFLIGHT_MAX) return false;
    return true;
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

  /**
   * **原子准入**：一次判定并占用「冷却 + 在飞上限 + 大文件槽位 + 复制并发」。
   *
   * 为什么必须原子：历史实现里 `openSourceStream` 完全不检查冷却与在飞上限，
   * `beginAttempt` 只做 `inflight += 1`。于是「源账号兜底」会在该账号已被
   * DC-5 限流（冷却中）时继续硬打，把冷却窗口不断延长——生产现象就是
   * 单一账号独扛全部 4GB 回源并持续 FLOOD_WAIT。判定与占用必须在一个同步块内完成，
   * 否则并发请求会各自通过校验再超额占用（`await` 之后判定即失效）。
   *
   * 与 `beginAttempt` 的关系：后者保留为**向后兼容**的纯记账入口（上传/镜像等
   * 既有调用点），新代码一律走本方法。二者共享同一 `inflight` 计数，
   * 因此旧调用点占用的额度同样会被新准入看见。
   */
  admit(request: AccountAdmissionRequest): AccountAdmissionResult {
    const runtime = this.runtimes.get((request.accountId || '').trim());
    if (!runtime) return { granted: false, reason: 'unknown_account' };
    if (request.shuttingDown) return { granted: false, reason: 'unknown_account' };

    const now = Date.now();
    if (!runtime.config.enabled) return { granted: false, reason: 'disabled' };
    if (runtime.cooldownUntilMs > now) {
      return {
        granted: false,
        reason: 'cooling_down',
        retryAfterMs: Math.max(0, runtime.cooldownUntilMs - now),
      };
    }
    if (runtime.inflight >= runtime.config.maxInflight) {
      return { granted: false, reason: 'inflight_full', retryAfterMs: ADMISSION_RETRY_AFTER_MS };
    }

    const role: AccountAttemptRole = request.role ?? 'download';
    const largeFile = isLargeFileBytes(request.bytes);
    if (largeFile && role !== 'replication') {
      if (runtime.largeInflight >= this.maxLargeInflightOf(runtime)) {
        return { granted: false, reason: 'large_inflight_full', retryAfterMs: ADMISSION_RETRY_AFTER_MS };
      }
    }
    if (role === 'replication' && runtime.replicationInflight >= REPLICATION_INFLIGHT_MAX) {
      return { granted: false, reason: 'replication_full', retryAfterMs: ADMISSION_RETRY_AFTER_MS };
    }

    // 同步占用（本方法内无 await，判定与占用不可被拆分）
    runtime.inflight += 1;
    if (largeFile && role !== 'replication') runtime.largeInflight += 1;
    if (role === 'replication') runtime.replicationInflight += 1;

    return {
      granted: true,
      admission: this.buildAdmission(runtime, role, largeFile),
    };
  }

  /** 每账号大文件回源槽位（未配置时为默认值 1） */
  private maxLargeInflightOf(runtime: TelegramAccountRuntime): number {
    const configured = runtime.config.maxLargeInflight;
    if (Number.isSafeInteger(configured) && (configured as number) > 0) return configured as number;
    return LARGE_INFLIGHT_DEFAULT;
  }

  /** 构造幂等归还句柄：finish 产生采样，release 不产生采样（客户端取消不计 flood） */
  private buildAdmission(
    runtime: TelegramAccountRuntime,
    role: AccountAttemptRole,
    largeFile: boolean,
  ): AccountAttemptAdmission {
    let settled: 'finish' | 'release' | null = null;
    const releaseCounters = (): void => {
      runtime.inflight = Math.max(0, runtime.inflight - 1);
      if (largeFile && role !== 'replication') {
        runtime.largeInflight = Math.max(0, runtime.largeInflight - 1);
      }
      if (role === 'replication') {
        runtime.replicationInflight = Math.max(0, runtime.replicationInflight - 1);
      }
    };
    return {
      accountId: runtime.config.id,
      role,
      largeFile,
      finish: (sample?: AccountAttemptSample): void => {
        if (settled) return;
        settled = 'finish';
        releaseCounters();
        this.finishAttempt(runtime.config.id, sample ?? { ok: true });
      },
      release: (): void => {
        if (settled) return;
        settled = 'release';
        releaseCounters();
      },
    };
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
      accounts: Array.from(this.runtimes.values()).map((runtime) => this.toAccountSnapshot(runtime)),
    };
  }

  /**
   * 单个账号的运行态脱敏条目（未注册时返回 null）。
   * 供后台账号列表把「数据库账号」与「池内运行态」对齐展示（按账号 id 匹配）。
   */
  runtimeView(accountId: string): AccountPoolAccountSnapshot | null {
    const runtime = this.runtimes.get((accountId || '').trim());
    return runtime ? this.toAccountSnapshot(runtime) : null;
  }

  private toAccountSnapshot(runtime: TelegramAccountRuntime): AccountPoolAccountSnapshot {
    const now = Date.now();
    return {
      id: runtime.config.id,
      tokenPreview: this.tokenPreview(runtime.config.token),
      chatId: runtime.config.chatId,
      enabled: runtime.config.enabled,
      weight: runtime.config.weight,
      maxInflight: runtime.config.maxInflight,
      inflight: runtime.inflight,
      largeInflight: runtime.largeInflight,
      maxLargeInflight: this.maxLargeInflightOf(runtime),
      replicationInflight: runtime.replicationInflight,
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
      source: runtime.config.source ?? 'env',
      primary: runtime.config.primary === true,
      storageConfigured: Boolean(runtime.config.chatId),
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
