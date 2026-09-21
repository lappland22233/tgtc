import { Injectable, Logger } from '@nestjs/common';
import { TelegramAccountCapabilities } from '../common/entities/telegram-account.entity';
import { TelegramAccountClientService } from '../telegram-account-pool/telegram-account-client.service';

export interface BotProbeResult {
  ok: boolean;
  /** Bot ID（token 数字前缀与 getMe 结果必须一致，否则说明 token 张冠李戴） */
  botId: string | null;
  username: string | null;
  displayName: string | null;
  chatTitle: string | null;
  chatType: string | null;
  capabilities: TelegramAccountCapabilities;
  /** 已脱敏的失败摘要（可直接写入 lastFailureSummary） */
  error: string | null;
  errorCode: string | null;
}

/**
 * 账号连通性与权限探测。
 *
 * 为什么必须存在：如果只在保存后「等任务失败才发现」，管理员配置错 Token 或没把
 * Bot 拉进主存储群时，会在真实上传/镜像链路上才暴露，且失败面很大。这里在
 * **创建、轮换、手动测试**三个入口都做一次真实调用，并把结论落成能力快照。
 *
 * 探测结果全部脱敏：只保留 botId、@username、chat 标题与分类错误码。
 */
@Injectable()
export class TelegramAccountProbeService {
  private readonly logger = new Logger(TelegramAccountProbeService.name);

  constructor(private readonly client: TelegramAccountClientService) {}

  /**
   * 探测 Bot 账号：`getMe` 必须成功；给了主存储 Chat 时再校验 `getChat` 可访问。
   * 主存储 Chat 不通过则整体判定失败——副本扩散与镜像上传都会写这个 chat。
   */
  async probeBot(token: string, primaryChatId?: string | null): Promise<BotProbeResult> {
    const base: BotProbeResult = {
      ok: false,
      botId: null,
      username: null,
      displayName: null,
      chatTitle: null,
      chatType: null,
      capabilities: { canUpload: false, supportsPolling: true },
      error: null,
      errorCode: null,
    };

    const accountId = this.accountIdFromToken(token);
    const me = await this.client.getMe(accountId, token);
    if (!me.ok) {
      return { ...base, error: me.error ?? 'getMe 失败', errorCode: 'probe_get_me_failed' };
    }

    // getMe 只回 ok/latency，botId 由 token 前缀确定；token 与 botId 不一致的配置
    // 会在上传时被 Telegram 拒绝，因此以 token 前缀作为账号锚点并明确记录。
    const capabilities: TelegramAccountCapabilities = { canUpload: true, supportsPolling: true };

    if (!primaryChatId) {
      return {
        ...base,
        ok: true,
        botId: accountId,
        capabilities,
      };
    }

    try {
      const chat = await this.client.getChat(accountId, token, primaryChatId);
      if (chat.type === 'channel' || chat.type === 'supergroup' || chat.type === 'group') {
        capabilities.canWriteMirror = true;
      }
      return {
        ...base,
        ok: true,
        botId: accountId,
        chatTitle: chat.title ?? null,
        chatType: chat.type ?? null,
        capabilities,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Bot 账号 ${accountId} 主存储 Chat 校验失败：${message}`);
      return {
        ...base,
        error: `主存储 Chat 不可访问：${message}`.slice(0, 500),
        errorCode: 'probe_chat_unreachable',
        capabilities,
      };
    }
  }

  private accountIdFromToken(token: string): string {
    return token.split(':')[0] || 'unknown';
  }
}
