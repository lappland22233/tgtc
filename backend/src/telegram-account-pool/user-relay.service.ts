import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface UserRelayRequest {
  /** 源消息所在 chat（通常是接收文件的 bot 与用户的私聊，或归档群） */
  sourceChatId: string;
  /** 源消息 ID */
  sourceMessageId: string;
  /** 中继目标群（各 bot 均为管理员的归档群） */
  targetChatId: string;
}

export interface UserRelayResult {
  ok: boolean;
  /** 中继后群里的新消息 ID（可用于把该消息与逻辑文件关联） */
  messageId?: string;
  reason?: string;
}

/**
 * 用户账号中继（策略 B 的接入点）。
 *
 * **为什么必须有这一层而不是直接用 bot 转发**：Telegram 明确规定
 * 「bot 永远看不到其它 bot 发送的消息」（与隐私模式、管理员身份无关，本实验已实测）。
 * 因此「接收 bot 转发到群」**不能**让其它 bot 获得该文件；只有**用户账号**发出的消息
 * 才能被群里所有 bot（管理员）看到，从而各自拿到自己的 `file_id`。
 *
 * 当前状态（重要，勿误判为已实现）：
 * - 本服务只提供**契约与配置闸门**；真正的 MTProto 客户端尚未接入。
 * - 原因：需要新增依赖（`tdl` 或 `telegram`/gramjs）+ 手机号登录产生的 session 文件，
 *   这两项都属于需要用户明确授权的敏感变更，不在本轮自动落地范围内。
 * - 未配置时 `relay()` 返回 `{ok:false, reason:'user_relay_not_configured'}`，
 *   上层会**自动回退到策略 A（副本扩散）**，因此不影响功能可用性。
 *
 * 接入方式（供后续实施）：实现 `relay()` 里的 TODO，把消息用用户账号
 * `forwardMessages` 到 `targetChatId`；随后各 bot 的长轮询会收到该消息，
 * 由入站链路登记各自的副本（无需额外代码）。
 */
@Injectable()
export class UserRelayService {
  private readonly logger = new Logger(UserRelayService.name);
  private readonly enabled: boolean;
  private readonly sessionFile: string;
  private readonly archiveChatIdValue: string;

  constructor(private readonly configService: ConfigService) {
    this.enabled = (this.configService.get<string>('TELEGRAM_USER_RELAY_ENABLED') || '')
      .trim()
      .toLowerCase() === 'true';
    this.sessionFile = (this.configService.get<string>('TELEGRAM_USER_SESSION_FILE') || '').trim();
    this.archiveChatIdValue = (
      this.configService.get<string>('TELEGRAM_ARCHIVE_CHAT_ID')
      || this.configService.get<string>('TELEGRAM_CHAT_ID')
      || ''
    ).trim();
    if (this.enabled) {
      this.logger.warn(
        'TELEGRAM_USER_RELAY_ENABLED=true，但 MTProto 用户客户端尚未接入（需 tdl/gramjs + session 文件）——'
        + '本次将回退到策略 A（各账号副本扩散）',
      );
    }
  }

  /** 是否具备用户账号中继能力（配置齐备**且**客户端已接入） */
  isConfigured(): boolean {
    // 客户端接入状态：当前为未接入（见类注释）。接入 MTProto 后改为真实探测。
    const clientReady = false;
    return clientReady && this.enabled && this.sessionFile.length > 0 && this.archiveChatIdValue.length > 0;
  }

  /** 中继目标群（各 bot 均为管理员的归档群） */
  archiveChatId(): string {
    return this.archiveChatIdValue;
  }

  /** 是否已开启中继开关（用于报告与排障，不代表可用） */
  isEnabledByConfig(): boolean {
    return this.enabled;
  }

  async relay(request: UserRelayRequest): Promise<UserRelayResult> {
    if (!this.isConfigured()) {
      return { ok: false, reason: 'user_relay_not_configured' };
    }
    // TODO(B 策略实施)：用用户账号把 sourceChatId/sourceMessageId 转发到 targetChatId。
    // 依赖：新增 MTProto 客户端依赖 + session 文件（TELEGRAM_USER_SESSION_FILE）+ 风控评估。
    this.logger.warn(
      `用户账号中继已配置但客户端未接入：${request.sourceChatId}/${request.sourceMessageId} → ${request.targetChatId}`,
    );
    return { ok: false, reason: 'user_relay_not_implemented' };
  }
}
