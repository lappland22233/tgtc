import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from '../telegram/telegram.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { TelegramBotDispatchService } from './telegram-bot-dispatch.service';
import {
  BOT_UPDATE_OFFSET_KEY,
  BOT_UPDATE_OFFSET_OWNER_KEY,
  TelegramBotPollingAccountSnapshot,
  TelegramBotPollingMode,
  TelegramBotPollingSelfCheck,
  TelegramBotPollingSnapshot,
} from './telegram-bot.types';
import { redactBotToken } from '../common/utils/sensitive-data';
import { TelegramAccountClientService } from '../telegram-account-pool/telegram-account-client.service';
import { TelegramAccountPoolService } from '../telegram-account-pool/telegram-account-pool.service';

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;
/** 关闭时等待当前长轮询循环退出的上限 */
const SHUTDOWN_WAIT_MS = 5000;
/** 入站自检默认延迟（秒）：足够覆盖一次长轮询往返，又不至于让启动诊断迟到太久 */
const INBOUND_SELF_CHECK_DEFAULT_SECONDS = 20;
/** 入站自检延迟上限（秒）：避免误配置成小时级使自检形同关闭 */
const INBOUND_SELF_CHECK_MAX_SECONDS = 300;
/** 诊断快照中错误摘要的最大长度 */
const LAST_ERROR_SUMMARY_LIMIT = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 每个账号的长轮询循环状态（池化模式；offset 必须按账号独立）。
 *
 * `startedAtMs` 之后的字段全部是**只读诊断**用：只参与 `snapshot()` 的计数与时间戳
 * 展示，不参与任何调度决策；错误摘要写入前必须已脱敏并截断。
 */
interface AccountPollState {
  accountId: string;
  offset: number;
  backoffMs: number;
  running: boolean;
  promise: Promise<void> | null;
  /** 该账号循环的启动时刻（毫秒） */
  startedAtMs: number;
  /** 最近一次成功返回 getUpdates 的时刻（毫秒） */
  lastPollAtMs: number | null;
  /** 最近一次取到非空更新批次的时刻（毫秒） */
  lastUpdateAtMs: number | null;
  /** 成功轮询次数（进程内累计） */
  pollCount: number;
  /** 累计消费的更新条数（进程内累计） */
  updateCount: number;
  /** 连续失败次数（成功后清零） */
  consecutiveFailures: number;
  /** 最近一次失败时刻（毫秒） */
  lastErrorAtMs: number | null;
  /** 最近一次失败摘要（已脱敏、已截断） */
  lastErrorSummary: string | null;
}

/**
 * 入站长轮询消费者。
 *
 * 两种模式：
 * - **单账号（原行为）**：账号池未启用时，保持单消费者 + 单一 offset（`BOT_UPDATE_OFFSET_KEY`）；
 * - **多账号（池化）**：每个 Bot 账号一个独立循环与独立 offset
 *   （`<BOT_UPDATE_OFFSET_KEY>:<accountId>`），并把 accountId 传给分发层——
 *   这是「任意一个 bot 收到文件都要能记录归属」的前提。
 *
 * 其它不变量保持不变：仅在 `TELEGRAM_BOT_UPDATES_ENABLED=true` 时启动；异常指数退避；
 * 先推进 offset 再处理（处理失败不重复消费）。
 */
@Injectable()
export class TelegramBotPollingService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TelegramBotPollingService.name);
  private readonly enabled: boolean;
  private readonly pollTimeoutSeconds: number;
  /** 入站自检延迟（毫秒）；`0` = 关闭自检 */
  private readonly selfCheckDelayMs: number;
  private running = false;
  private offset = 0;
  private backoffMs = INITIAL_BACKOFF_MS;
  private loopPromise: Promise<void> | null = null;
  /** 池化模式下的每账号循环 */
  private readonly accountStates = new Map<string, AccountPollState>();
  /** 启动时确定的入站模式（运行期不重建循环；漂移经 snapshot().modeDrift 暴露） */
  private mode: TelegramBotPollingMode = 'disabled';
  /** 入站消费启动时刻（毫秒） */
  private startedAtMs: number | null = null;
  /** 最近一次任一循环成功返回 getUpdates 的时刻（毫秒） */
  private lastPollAtMs: number | null = null;
  /** 启动后一次性行为自检结论；null = 尚未到自检时间或自检已关闭 */
  private selfCheck: TelegramBotPollingSelfCheck | null = null;
  private selfCheckTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly telegramService: TelegramService,
    private readonly dispatchService: TelegramBotDispatchService,
    private readonly configCacheService: ConfigCacheService,
    private readonly configService: ConfigService,
    private readonly pool: TelegramAccountPoolService,
    private readonly accountClient: TelegramAccountClientService,
  ) {
    this.enabled = (this.configService.get<string>('TELEGRAM_BOT_UPDATES_ENABLED') || '').trim().toLowerCase() === 'true';
    const poll = Number(this.configService.get<string>('TELEGRAM_BOT_POLL_TIMEOUT_SECONDS') || 30);
    this.pollTimeoutSeconds = Number.isSafeInteger(poll) && poll >= 1 && poll <= 120 ? poll : 30;
    this.selfCheckDelayMs = this.resolveSelfCheckDelayMs();
  }

  /**
   * 入站自检延迟解析（与 `TELEGRAM_BOT_POLL_TIMEOUT_SECONDS` 同风格）。
   *
   * 注意两种策略并存，不要误读：**未设置/无法解析/非正整数 → 回落默认 20s**，
   * 而**正整数越界 → 夹取到 1–300s**。因此 `1.5` 会按 20s 生效，`500` 会按 300s 生效。
   */
  private resolveSelfCheckDelayMs(): number {
    const raw = (this.configService.get<string>('TELEGRAM_BOT_INBOUND_SELF_CHECK_SECONDS') || '').trim();
    if (!raw) return INBOUND_SELF_CHECK_DEFAULT_SECONDS * 1000;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return INBOUND_SELF_CHECK_DEFAULT_SECONDS * 1000;
    if (parsed === 0) return 0;
    if (!Number.isSafeInteger(parsed) || parsed < 1) return INBOUND_SELF_CHECK_DEFAULT_SECONDS * 1000;
    return Math.min(parsed, INBOUND_SELF_CHECK_MAX_SECONDS) * 1000;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.mode = 'disabled';
      this.logger.log('Telegram Bot 入站消费已关闭（TELEGRAM_BOT_UPDATES_ENABLED != true）');
      return;
    }

    // 模式在启动时一次性确定：运行期重建循环会让同一 Bot 出现两个消费者或重放旧更新
    this.startedAtMs = Date.now();

    if (this.pool.isActive()) {
      this.mode = 'pooled';
      const accountIds = this.pool.ids();
      // 共享消费态开关：池化分支必须在启动任何 accountLoop **之前**置位。
      //
      // 为什么必须是第一件事：accountLoop 的循环条件是
      // `while (this.running && state.running)`，而 `this.running` 只在本方法里被置位。
      // 池化分支处理完账号后会 `return`，跳过单账号路径的置位——漏掉这一步会让
      // 循环条件恒为 `false && true`，循环体一次都不执行，入站消费彻底空转，
      // 且不产生任何日志或异常（v1.5.3 P0 回归的直接原因）。
      //
      // 为什么位置必须在 for 之前：`state.promise = this.accountLoop(state)` 会
      // **同步**求值循环条件，置位晚于它会同样导致循环立即退出。
      this.running = true;
      this.logger.log(`Telegram Bot 入站消费已启动（池化模式，${accountIds.length} 个账号各自长轮询）`);
      for (const accountId of accountIds) {
        await this.warnIfWebhookConfigured(accountId);
        const state: AccountPollState = {
          accountId,
          offset: await this.resolveInitialOffset(accountId),
          backoffMs: INITIAL_BACKOFF_MS,
          running: true,
          promise: null,
          startedAtMs: Date.now(),
          lastPollAtMs: null,
          lastUpdateAtMs: null,
          pollCount: 0,
          updateCount: 0,
          consecutiveFailures: 0,
          lastErrorAtMs: null,
          lastErrorSummary: null,
        };
        state.promise = this.accountLoop(state);
        this.accountStates.set(accountId, state);
        this.logger.log(`账号 ${accountId} 入站循环已启动（offset=${state.offset}）`);
      }
      this.scheduleSelfCheck();
      return;
    }

    this.mode = 'single';
    await this.warnIfWebhookConfigured();
    this.offset = await this.loadOffset(BOT_UPDATE_OFFSET_KEY);
    // 记录全局 offset 的归属，供后续切到池化模式时安全继承
    await this.persistOwnerMarker(this.defaultBotAccountId());
    this.running = true;
    this.logger.log(`Telegram Bot 入站消费已启动（单账号长轮询 ${this.pollTimeoutSeconds}s，offset=${this.offset}）`);
    this.loopPromise = this.loop();
    this.scheduleSelfCheck();
  }

  private offsetKeyFor(accountId: string): string {
    return `${BOT_UPDATE_OFFSET_KEY}:${accountId}`;
  }

  /**
   * 池化模式下每账号 offset 的初始值。
   *
   * 为什么需要继承：某个账号从「单账号模式」（用全局键 `BOT_UPDATE_OFFSET_KEY`）
   * 切到「池化模式」（用账号级键）时，账号级键是全新的（0），直接用会让 Telegram
   * 重放约 24 小时的更新（重复下载、重复回复、重复登记副本）。
   *
   * 但**不能无差别继承**：不同 Bot 的 `update_id` 是各自独立的序列，
   * 把 A 的偏移套到 B 上会跳过 B 尚未消费的更新（入站文件永久丢失）。
   * 因此只在「全局 offset 明确属于该账号」时继承，归属判定顺序：
   * 1. `BOT_UPDATE_OFFSET_OWNER_KEY` 归属标记（新一轮启动会写入）；
   * 2. 旧部署没有标记时，按「该账号就是环境变量主 Bot」推断（升级路径最典型的情形）。
   */
  private async resolveInitialOffset(accountId: string): Promise<number> {
    const key = this.offsetKeyFor(accountId);
    const own = await this.loadOffset(key);
    if (own > 0) return own;

    const owner = await this.loadOwnerMarker();
    const belongsToAccount = owner
      ? owner === accountId
      : accountId === this.pool.primaryAccountId();
    if (!belongsToAccount) return own;

    const inherited = await this.loadOffset(BOT_UPDATE_OFFSET_KEY);
    if (inherited <= own) return own;

    this.logger.log(
      `账号 ${accountId} 继承历史全局 offset（${inherited}）以避免重放旧更新（账号级键：${key}）`,
    );
    await this.persistOffset(key, inherited);
    await this.persistOwnerMarker(accountId);
    return inherited;
  }

  private async loadOffset(key: string): Promise<number> {
    try {
      const stored = await this.configCacheService.get(key, '0');
      const parsed = Number(stored);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    } catch {
      return 0;
    }
  }

  /** 环境变量主 Bot 的账号 id（`TELEGRAM_BOT_TOKEN` 的数字前缀） */
  private defaultBotAccountId(): string | null {
    const raw = this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '';
    const token = raw.trim();
    const prefix = token.split(':')[0];
    return prefix && token.includes(':') ? prefix : null;
  }

  /** 读取全局 offset 的归属 Bot（旧部署可能没有） */
  private async loadOwnerMarker(): Promise<string | null> {
    try {
      const stored = await this.configCacheService.get(BOT_UPDATE_OFFSET_OWNER_KEY, '');
      const trimmed = (stored || '').trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  /** 写入全局 offset 的归属 Bot（幂等；值未变化时不写库） */
  private async persistOwnerMarker(botId: string | null): Promise<void> {
    if (!botId) return;
    try {
      const current = await this.loadOwnerMarker();
      if (current === botId) return;
      await this.configCacheService.set(
        BOT_UPDATE_OFFSET_OWNER_KEY,
        botId,
        'Telegram Bot 长轮询 offset 归属（自动维护）',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`offset 归属标记写入失败（忽略）: ${message}`);
    }
  }

  /** R1：检测 Webhook 冲突（Webhook 与 getUpdates 互斥）；池化模式逐账号检测 */
  private async warnIfWebhookConfigured(accountId?: string): Promise<void> {
    try {
      if (accountId) {
        const account = this.pool.getConfig(accountId);
        if (!account) return;
        const info = await this.accountClient.getWebhookInfo(accountId, account.token);
        if (info.url) {
          this.logger.error(`账号 ${accountId} 已设置 Webhook，getUpdates 将失败（409）；请先移除 Webhook。`);
        }
        return;
      }
      const info = await this.telegramService.getWebhookInfo();
      if (info.url) {
        this.logger.error(
          '检测到 Bot 已设置 Webhook，getUpdates 将失败（409）。'
          + '请先调用 deleteWebhook 移除 Webhook，或关闭入站消费开关。',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Webhook 状态检测失败（忽略）: ${message}`);
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.telegramService.getUpdates(this.offset, this.pollTimeoutSeconds);
        this.backoffMs = INITIAL_BACKOFF_MS;
        this.lastPollAtMs = Date.now();

        if (updates.length > 0) {
          for (const update of updates) {
            if (!this.running) break;
            // 先推进 offset 再处理：处理失败也不会导致重复消费已确认的更新
            if (update.update_id >= this.offset) {
              this.offset = update.update_id + 1;
            }
            await this.dispatchService.handleUpdate(update);
          }
          // 整批处理完成后持久化 offset（崩溃在持久化前 → 重投 + 幂等兜底）
          await this.persistOffset();
        }
      } catch (error) {
        if (!this.running) break;
        const summary = this.summarizeInboundError(error);
        const wait = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
        this.logger.warn(`getUpdates 失败，${wait}ms 后重试: ${summary}`);
        await sleep(wait);
      }
    }
  }

  /** 池化模式：单账号循环（使用账号池客户端，带上 accountId 上下文） */
  private async accountLoop(state: AccountPollState): Promise<void> {
    while (this.running && state.running) {
      const account = this.pool.getConfig(state.accountId);
      if (!account) break;
      try {
        const updates = await this.accountClient.getUpdates(
          state.accountId,
          account.token,
          state.offset,
          this.pollTimeoutSeconds,
        );
        state.backoffMs = INITIAL_BACKOFF_MS;
        state.pollCount += 1;
        state.consecutiveFailures = 0;
        state.lastPollAtMs = Date.now();
        // 服务级时间戳：单账号与池化共用「最近一次成功轮询」，供自检判断健康度
        this.lastPollAtMs = state.lastPollAtMs;
        if (updates.length > 0) {
          state.lastUpdateAtMs = state.lastPollAtMs;
          for (const update of updates) {
            if (!this.running || !state.running) break;
            const updateId = Number((update as { update_id?: number }).update_id ?? -1);
            if (updateId >= state.offset) state.offset = updateId + 1;
            state.updateCount += 1;
            await this.dispatchService.handleUpdate(
              update as unknown as Parameters<TelegramBotDispatchService['handleUpdate']>[0],
              { accountId: state.accountId },
            );
          }
          await this.persistOffset(this.offsetKeyFor(state.accountId), state.offset);
        }
      } catch (error) {
        if (!this.running || !state.running) break;
        // 先记录诊断再退避；日志与快照共用同一份已脱敏摘要，避免某条链路漏脱敏
        const summary = this.summarizeInboundError(error, account.token);
        state.consecutiveFailures += 1;
        state.lastErrorAtMs = Date.now();
        state.lastErrorSummary = summary;
        const wait = state.backoffMs;
        state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
        this.logger.warn(`账号 ${state.accountId} getUpdates 失败，${wait}ms 后重试: ${summary}`);
        await sleep(wait);
      }
    }
  }

  private async persistOffset(key: string = BOT_UPDATE_OFFSET_KEY, value: number = this.offset): Promise<void> {
    try {
      await this.configCacheService.set(
        key,
        String(value),
        'Telegram Bot 长轮询 offset（自动维护）',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`offset 持久化失败（忽略）: ${message}`);
    }
  }

  // ---------------- 只读诊断 ----------------

  /**
   * 入站长轮询运行态快照（供管理端只读诊断接口使用）。
   *
   * 安全约束：只暴露账号标识、偏移量、计数与时间戳；错误摘要已在写入前脱敏截断。
   * 绝不返回 Bot Token、file_id 或原始上游地址。
   */
  snapshot(): TelegramBotPollingSnapshot {
    return {
      enabled: this.enabled,
      mode: this.mode,
      running: this.running,
      startedAtMs: this.startedAtMs,
      lastPollAtMs: this.lastPollAtMs,
      selfCheck: this.selfCheck,
      modeDrift: this.modeDrift(),
      accounts: Array.from(this.accountStates.values()).map((state) => this.toAccountSnapshot(state)),
    };
  }

  private toAccountSnapshot(state: AccountPollState): TelegramBotPollingAccountSnapshot {
    return {
      accountId: state.accountId,
      running: state.running,
      offset: state.offset,
      pollCount: state.pollCount,
      updateCount: state.updateCount,
      consecutiveFailures: state.consecutiveFailures,
      lastPollAtMs: state.lastPollAtMs,
      lastErrorAtMs: state.lastErrorAtMs,
      lastErrorSummary: state.lastErrorSummary,
    };
  }

  /**
   * 启动期模式与当前账号池状态是否已漂移。
   *
   * 为什么只提示不自动切换：池化/单账号的切换涉及 offset 键空间与循环结构，
   * 运行期重建循环会让同一 Bot 出现两个消费者，或按错误的键空间重放旧更新。
   * 因此保持「启动时定模式」这一既有约定，但把它变成**可见**的（此前是静默不一致）。
   */
  private modeDrift(): TelegramBotPollingSnapshot['modeDrift'] {
    const poolActive = this.pool.isActive();
    if (this.mode === 'single' && poolActive) {
      return {
        restartRequired: true,
        reason: '账号池已启用，但入站循环仍停留在启动时的单账号模式；需重启后才会按账号分别长轮询',
      };
    }
    if (this.mode === 'pooled' && !poolActive) {
      return {
        restartRequired: true,
        reason: '账号池已停用，但入站循环仍在按账号长轮询；需重启后才会回到单账号模式',
      };
    }
    if (this.mode === 'pooled') {
      // 账号集合在运行期变化同样是「循环不会重建」带来的静默不一致：
      // 新增账号不会有人消费它的私聊消息，移除账号的循环也仍在跑。
      // 这里把它一并暴露出来，避免操作者只能靠比对 accounts 数量自行判断。
      const liveIds = this.pool.ids();
      const notPolled = liveIds.filter((id) => !this.accountStates.has(id));
      const stillPolling = Array.from(this.accountStates.keys()).filter((id) => !liveIds.includes(id));
      if (notPolled.length > 0 || stillPolling.length > 0) {
        return {
          restartRequired: true,
          reason: `账号集合已变化（新增未消费：${notPolled.join(', ') || '无'}；已移除但仍轮询：`
            + `${stillPolling.join(', ') || '无'}），入站循环只在启动时建立过一次；需重启后生效`,
        };
      }
    }
    return { restartRequired: false, reason: null };
  }

  /**
   * 启动后一次性行为自检。
   *
   * 为什么不只是断言 `this.running === true`：那是同义反复，防不住「条件写错导致
   * 循环体一次都不执行」。v1.5.3 的 P0 回归正是这种形态——已启用且处于消费态，
   * 却没有任何一次成功的 getUpdates，且全程无日志无异常（offset 永不推进）。
   * 这里改用「有没有真的成功轮询过」这个可观测事实来判断，并把结论写进快照。
   */
  private scheduleSelfCheck(): void {
    if (this.selfCheckDelayMs <= 0) return;
    this.clearSelfCheckTimer();
    const timer = setTimeout(() => this.runSelfCheck(), this.selfCheckDelayMs);
    // 不阻止进程退出（与 sleep() 同策略）
    timer.unref?.();
    this.selfCheckTimer = timer;
  }

  private runSelfCheck(): void {
    this.selfCheckTimer = null;
    // 未启用或已停止时不存在「空转」语义，不做结论（避免关闭期误报）
    if (!this.enabled || !this.running) return;

    const healthy = this.lastPollAtMs !== null;
    const subject = this.mode === 'pooled' ? `${this.accountStates.size} 个账号` : '单账号';
    const message = healthy
      ? `${subject}入站轮询正常（最近一次成功 getUpdates：${new Date(this.lastPollAtMs as number).toISOString()}）`
      : '入站轮询疑似空转：已启用入站消费且运行态为 true，但启动后没有任何一次成功的 getUpdates。'
        + '请依次排查：TELEGRAM_BOT_UPDATES_ENABLED 与账号池开关的实际取值、'
        + 'Bot 是否已设置 Webhook（Webhook 与 getUpdates 互斥，会返回 409）、'
        + '账号池是否注册了可用账号、以及上游 Telegram API 的可达性。';
    this.selfCheck = { atMs: Date.now(), healthy, message };
    // 只在异常时输出一次，不做周期性刷屏（正常路径由启动日志覆盖）
    if (!healthy) this.logger.error(message);
  }

  private clearSelfCheckTimer(): void {
    if (!this.selfCheckTimer) return;
    clearTimeout(this.selfCheckTimer);
    this.selfCheckTimer = null;
  }

  /**
   * 归一化入站错误摘要。
   *
   * **顺序不能反**：必须先把 URL 形态与字面 Token 替换掉再截断——先截断可能把
   * Token 切成两半，导致字面替换失配、凭据碎片进入日志与诊断接口。
   * `token` 只用于替换，绝不写入任何输出。
   */
  private summarizeInboundError(error: unknown, token?: string | null): string {
    const raw = error instanceof Error ? error.message : String(error);
    const literal = (token || '').trim()
      || (this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '').trim();
    return redactBotToken(raw, literal)
      .replace(/[\u0000-\u001F\u007F]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, LAST_ERROR_SUMMARY_LIMIT);
  }

  async onApplicationShutdown(): Promise<void> {
    // 自检定时器必须先清掉：否则关闭后仍可能触发一次结论写入
    this.clearSelfCheckTimer();
    if (!this.enabled) return;
    this.running = false;
    for (const state of this.accountStates.values()) {
      state.running = false;
    }
    const pending = [this.loopPromise, ...Array.from(this.accountStates.values()).map((item) => item.promise)]
      .filter((item): item is Promise<void> => item !== null);
    for (const promise of pending) {
      const completed = await Promise.race([
        promise.then(() => true).catch(() => true),
        sleep(SHUTDOWN_WAIT_MS).then(() => false),
      ]);
      if (!completed) {
        this.logger.warn('Telegram Bot 长轮询循环未在关闭窗口内退出（将在进程退出时终止）');
      }
    }
  }
}
