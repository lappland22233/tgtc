import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TelegramAccountPoolService } from '../telegram-account-pool/telegram-account-pool.service';
import { TelegramAccountConfig } from '../telegram-account-pool/telegram-account-pool.types';
import { ACCOUNT_FEATURE_KEYS, TelegramAccountFeatureService } from './telegram-account-feature.service';
import { TelegramAccountsService } from './telegram-accounts.service';

/** 面板账号刷新间隔：管理员在后台增删账号后最多 1 分钟生效（单实例内存态，无需重启） */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * 账号管理 ↔ 账号池 的装配桥接。
 *
 * 为什么需要桥接而不是互相 import：
 * - 账号管理模块需要账号池的 `TelegramAccountClientService` 做连通性探测；
 * - 账号池需要账号管理模块提供「数据库账号 + 运行时开关」。
 * 二者互相 import 会形成模块环，因此账号池只暴露 `registerAccountSource` 回调，
 * 由本服务在装配阶段注册，并按 60s 周期（或配置热更新事件触发）刷新。
 *
 * 生效语义：
 * - 面板新增/启用/停用账号 → 下一轮刷新即生效，**无需重启**；
 * - 关闭总开关 → `pool.isActive()` 立即变 false，只阻止新任务，不中断在途传输。
 */
@Injectable()
export class TelegramAccountPoolBridgeService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TelegramAccountPoolBridgeService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: TelegramAccountPoolService,
    private readonly accounts: TelegramAccountsService,
    private readonly feature: TelegramAccountFeatureService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.pool.registerAccountSource(() => this.loadPanelAccounts());
    await this.sync();
    this.timer = setInterval(() => void this.sync(), REFRESH_INTERVAL_MS);
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 配置热更新事件：开关一改立即同步，不必等下一个周期 */
  @OnEvent('config.changed')
  async onConfigChanged(payload: { key?: string }): Promise<void> {
    if (payload?.key && payload.key !== ACCOUNT_FEATURE_KEYS.accountPool) return;
    await this.sync();
  }

  /** 同步运行时开关与面板账号（幂等） */
  async sync(): Promise<void> {
    try {
      const state = await this.feature.getState();
      await this.pool.refreshExternalAccounts(state.accountPoolEnabled);
    } catch (error) {
      this.logger.warn(`账号池同步失败（下轮重试）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 面板账号 → 池配置（只取已解密且具备存储 Chat 的可用 Bot 账号） */
  private async loadPanelAccounts(): Promise<TelegramAccountConfig[]> {
    const rows = await this.accounts.resolveEnabledBotAccounts();
    return rows
      .filter((row) => Boolean(row.chatId))
      .map((row) => ({
        id: row.accountId,
        token: row.token,
        chatId: row.chatId,
        weight: row.weight,
        maxInflight: row.maxInflight,
        enabled: true,
        note: '后台账号',
        source: 'panel' as const,
      }));
  }
}
