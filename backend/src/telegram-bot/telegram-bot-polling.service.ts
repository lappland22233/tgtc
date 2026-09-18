import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from '../telegram/telegram.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { TelegramBotDispatchService } from './telegram-bot-dispatch.service';
import { BOT_UPDATE_OFFSET_KEY } from './telegram-bot.types';

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

/**
 * 单实例长轮询消费者。
 *
 * - 仅在 `TELEGRAM_BOT_UPDATES_ENABLED=true` 时启动（默认关闭；启动期读取，不热更新）；
 * - offset 持久化到 SystemConfig，重启不丢更新（R7）；
 * - 异常指数退避（1s → 60s），不崩溃、不丢更新；
 * - 单消费者约束（R1/R4）：同一 Bot Token 只能有一个入站消费者，
 *   启动时检测 Webhook 冲突并告警。
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

  constructor(
    private readonly telegramService: TelegramService,
    private readonly dispatchService: TelegramBotDispatchService,
    private readonly configCacheService: ConfigCacheService,
    private readonly configService: ConfigService,
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

    await this.warnIfWebhookConfigured();

    try {
      const stored = await this.configCacheService.get(BOT_UPDATE_OFFSET_KEY, '0');
      const parsed = Number(stored);
      this.offset = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    } catch {
      this.offset = 0;
    }

    this.running = true;
    this.logger.log(`Telegram Bot 入站消费已启动（长轮询 ${this.pollTimeoutSeconds}s，offset=${this.offset}）`);
    this.loopPromise = this.loop();
  }

  /** R1：检测 Webhook 冲突（Webhook 与 getUpdates 互斥） */
  private async warnIfWebhookConfigured(): Promise<void> {
    try {
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

  private async persistOffset(): Promise<void> {
    try {
      await this.configCacheService.set(
        BOT_UPDATE_OFFSET_KEY,
        String(this.offset),
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
    if (!this.loopPromise) return;
    const completed = await Promise.race([
      this.loopPromise.then(() => true).catch(() => true),
      sleep(SHUTDOWN_WAIT_MS).then(() => false),
    ]);
    if (!completed) {
      this.logger.warn('Telegram Bot 长轮询循环未在关闭窗口内退出（将在进程退出时终止）');
    }
  }
}
