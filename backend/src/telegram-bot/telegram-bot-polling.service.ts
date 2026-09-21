import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from '../telegram/telegram.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { TelegramBotDispatchService } from './telegram-bot-dispatch.service';
import { BOT_UPDATE_OFFSET_KEY } from './telegram-bot.types';
import { TelegramAccountClientService } from '../telegram-account-pool/telegram-account-client.service';
import { TelegramAccountPoolService } from '../telegram-account-pool/telegram-account-pool.service';

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;
/** 关闭时等待当前长轮询循环退出的上限 */
const SHUTDOWN_WAIT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** 每个账号的长轮询循环状态（池化模式；offset 必须按账号独立） */
interface AccountPollState {
  accountId: string;
  offset: number;
  backoffMs: number;
  running: boolean;
  promise: Promise<void> | null;
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
  private running = false;
  private offset = 0;
  private backoffMs = INITIAL_BACKOFF_MS;
  private loopPromise: Promise<void> | null = null;
  /** 池化模式下的每账号循环 */
  private readonly accountStates = new Map<string, AccountPollState>();

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
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('Telegram Bot 入站消费已关闭（TELEGRAM_BOT_UPDATES_ENABLED != true）');
      return;
    }

    if (this.pool.isActive()) {
      const accountIds = this.pool.ids();
      this.logger.log(`Telegram Bot 入站消费已启动（池化模式，${accountIds.length} 个账号各自长轮询）`);
      for (const accountId of accountIds) {
        await this.warnIfWebhookConfigured(accountId);
        const state: AccountPollState = {
          accountId,
          offset: await this.loadOffset(this.offsetKeyFor(accountId)),
          backoffMs: INITIAL_BACKOFF_MS,
          running: true,
          promise: null,
        };
        state.promise = this.accountLoop(state);
        this.accountStates.set(accountId, state);
        this.logger.log(`账号 ${accountId} 入站循环已启动（offset=${state.offset}）`);
      }
      return;
    }

    await this.warnIfWebhookConfigured();
    this.offset = await this.loadOffset(BOT_UPDATE_OFFSET_KEY);
    this.running = true;
    this.logger.log(`Telegram Bot 入站消费已启动（单账号长轮询 ${this.pollTimeoutSeconds}s，offset=${this.offset}）`);
    this.loopPromise = this.loop();
  }

  private offsetKeyFor(accountId: string): string {
    return `${BOT_UPDATE_OFFSET_KEY}:${accountId}`;
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
        const message = error instanceof Error ? error.message : String(error);
        const wait = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
        this.logger.warn(`getUpdates 失败，${wait}ms 后重试: ${message}`);
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
        if (updates.length > 0) {
          for (const update of updates) {
            if (!this.running || !state.running) break;
            const updateId = Number((update as { update_id?: number }).update_id ?? -1);
            if (updateId >= state.offset) state.offset = updateId + 1;
            await this.dispatchService.handleUpdate(
              update as unknown as Parameters<TelegramBotDispatchService['handleUpdate']>[0],
              { accountId: state.accountId },
            );
          }
          await this.persistOffset(this.offsetKeyFor(state.accountId), state.offset);
        }
      } catch (error) {
        if (!this.running || !state.running) break;
        const message = error instanceof Error ? error.message : String(error);
        const wait = state.backoffMs;
        state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
        this.logger.warn(`账号 ${state.accountId} getUpdates 失败，${wait}ms 后重试: ${message}`);
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

  async onApplicationShutdown(): Promise<void> {
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
