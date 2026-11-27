import { Inject, Injectable, Logger, Optional, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from '../telegram/telegram.service';
import { TelegramAccountClientService } from '../telegram-account-pool/telegram-account-client.service';
import { TelegramAccountPoolService } from '../telegram-account-pool/telegram-account-pool.service';
import { TelegramBotAdminService } from './telegram-bot-admin.service';
import { commandsFor, type BotCommandSpec } from './telegram-bot.commands';

/** 管理员菜单的去抖窗口：`/start`/`/help` 可能被反复触发，没必要每次都打远端 */
const ADMIN_SYNC_DEBOUNCE_MS = 10 * 60 * 1000;
/** Bot 未启动 / 被拉黑时的服务端文案：属于预期，不升级为告警 */
const EXPECTED_FAILURE = /chat not found|bot was blocked|user is deactivated|user not found|peer_id_invalid/i;
/** 方法本身不被支持时的文案：置为进程级禁用，避免每次启动都重试 */
const UNSUPPORTED_METHOD = /unsupported|unknown method|not implemented/i;

/**
 * Telegram 命令菜单（setMyCommands）同步。
 *
 * 为什么 best-effort：菜单只是输入框的 `/` 弹窗提示，**不承担权限控制**
 * （权限由 dispatch 在执行前校验）。因此这里任何失败都只记录，绝不影响消息处理。
 *
 * 两档菜单：
 * - `default` scope 只放用户命令——普通用户看不到管理命令的存在；
 * - 每个管理员一个 `chat` scope，放开全部命令。
 *
 * 管理员未与 Bot 建立过会话时服务端会返回 chat not found，这是预期状态（不是故障），
 * 等其首次 `/start` 后由去抖触发自动补齐。
 */
@Injectable()
export class TelegramBotCommandMenuService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramBotCommandMenuService.name);
  /** 各 scope 最近一次成功下发的 payload 指纹，内容未变则跳过重复请求 */
  private readonly pushed = new Map<string, string>();
  /** 管理员去抖：tgUserId -> 上次同步时刻 */
  private readonly lastAdminSync = new Map<string, number>();
  /** 远端不支持 setMyCommands 时永久关闭（进程生命周期内） */
  private disabled = false;

  constructor(
    private readonly telegramService: TelegramService,
    private readonly adminService: TelegramBotAdminService,
    @Optional() @Inject(ConfigService)
    private readonly configService: ConfigService | null = null,
    @Optional() @Inject(TelegramAccountPoolService)
    private readonly pool: TelegramAccountPoolService | null = null,
    @Optional() @Inject(TelegramAccountClientService)
    private readonly accountClient: TelegramAccountClientService | null = null,
  ) {}

  onApplicationBootstrap(): void {
    // 入站未启用时不碰远端：避免测试与只读部署产生额外网络请求
    const enabled = (this.configService?.get<string>('TELEGRAM_BOT_UPDATES_ENABLED') || '').trim().toLowerCase() === 'true';
    if (!enabled) return;
    // 延后一拍等轮询启动，且不让启动流程等待网络
    setTimeout(() => { void this.syncAll(); }, 0);
  }

  /** 同步默认 scope（用户菜单）与全部管理员的私人菜单 */
  async syncAll(): Promise<void> {
    await Promise.allSettled([
      this.syncDefault(),
      ...Array.from(this.adminService.getAdminIds()).map(id => this.syncAdmin(id)),
    ]);
  }

  /** 默认 scope：只含用户命令 */
  async syncDefault(): Promise<void> {
    await this.push('default', { type: 'default' }, commandsFor('user'));
  }

  /** 管理员私人菜单（去抖：10 分钟内不重复下发） */
  async syncAdmin(telegramUserId: string): Promise<void> {
    if (this.disabled) return;
    if (!/^\d{1,20}$/.test(telegramUserId)) return;
    const last = this.lastAdminSync.get(telegramUserId) ?? 0;
    if (Date.now() - last < ADMIN_SYNC_DEBOUNCE_MS) return;
    this.lastAdminSync.set(telegramUserId, Date.now());
    await this.push(`chat:${telegramUserId}`, { type: 'chat', chat_id: telegramUserId }, commandsFor('admin'));
  }

  /**
   * 下发一次菜单。
   *
   * 池化模式遍历所有活跃账号：每个 Bot 的菜单互不共享，只给默认 Bot 设会漏掉池中其它账号。
   */
  private async push(
    scopeKey: string,
    scope: Record<string, unknown>,
    specs: BotCommandSpec[],
  ): Promise<void> {
    if (this.disabled) return;
    const commands = specs
      .filter(spec => spec.name.length <= 32)
      .map(spec => ({ command: spec.name, description: spec.description.slice(0, 256) }));
    const fingerprint = JSON.stringify(commands);
    if (this.pushed.get(scopeKey) === fingerprint) return;

    const targets = this.targets();
    let anySuccess = false;
    for (const target of targets) {
      try {
        const ok = target.accountId
          ? await this.accountClient!.setMyCommands(target.accountId, target.token, commands, scope)
          : await this.telegramService.setMyCommands(commands, scope);
        anySuccess = anySuccess || ok;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (UNSUPPORTED_METHOD.test(message)) {
          this.disabled = true;
          this.logger.warn(`远端 Bot API 不支持 setMyCommands，已关闭命令菜单同步: ${message}`);
          return;
        }
        if (EXPECTED_FAILURE.test(message)) {
          this.logger.debug(`命令菜单暂不可下发（用户尚未与 Bot 会话）: scope=${scopeKey} ${message}`);
          continue;
        }
        this.logger.warn(`下发命令菜单失败: scope=${scopeKey} ${message}`);
      }
    }
    if (anySuccess) this.pushed.set(scopeKey, fingerprint);
  }

  /** 池化模式下每个活跃账号各一份菜单；否则走默认 Bot */
  private targets(): Array<{ accountId?: string; token: string }> {
    const pool = this.pool;
    const client = this.accountClient;
    if (pool?.isActive() && client) {
      const accounts = pool.ids()
        .map(id => pool.getConfig(id))
        .filter((account): account is NonNullable<typeof account> => Boolean(account?.token));
      if (accounts.length > 0) {
        return accounts.map(account => ({ accountId: account.id, token: account.token }));
      }
    }
    return [{ token: '' }];
  }
}
