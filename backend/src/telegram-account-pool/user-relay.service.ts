import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelegramMirrorRule } from '../common/entities/telegram-mirror-rule.entity';
import { TelegramUserClientService } from '../telegram-user/telegram-user-client.service';

/** 镜像规则（备份群）缓存 TTL：中继是低频操作，但也不该每次转发都打库 */
const MIRROR_TARGET_CACHE_TTL_MS = 60_000;

/**
 * 用户账号中继的**能力判定与目标群解析**（本服务不执行任何转发）。
 *
 * ## 职责边界（不可含糊）
 *
 * 副本扩散的**唯一执行器**是 `telegram-mirror/telegram-user-copy.service.ts`：
 * 「持有源消息的 Bot 先把消息转发进主群 → 用户账号从主群逐条转发到每个启用中的镜像群」。
 * 本服务只提供两项判定：
 * - `isConfigured()` / `isEnabledByConfig()`：能力预检（开关已开 + MTProto 客户端可加载）；
 * - `resolveTargetChatId()`：启用中镜像规则的目标群（预检展示口径，非执行依据）。
 *
 * 早期版本曾在本类内实现 `relay()` 执行原语，执行器落地后它已无任何生产调用方，
 * 为避免「两条执行路径」的歧义已整体删除（`no-strategy-a-guard.spec.ts` 同步覆盖）。
 *
 * 事实边界（不可含糊）：
 * - 中继是**服务端转发**（MTProto `messages.forwardMessages`），不重新下载/上传字节，
 *   但仍必须持有源 `chat_id + message_id`，且用户账号对源群可读、对目标群可写；
 * - 用户账号**读不到 bot 与其它用户的私聊**：`grant` 类来源（Bot 私聊入站文件）
 *   必须先由接收 Bot 用 Bot API 服务端转发进**主群**，见
 *   `telegram-mirror/telegram-main-chat-anchor.service.ts`；
 * - 目标群**唯一权威是启用中的镜像规则**（`targetChatId`），绝不回退归档群：
 *   归档群只是审计转发目的地，成员与权限没经过「全部 Bot 可见」校验，
 *   用它当中继目标会「转发成功但无人认领」——副本数长期为 0，而日志里全是成功。
 */
@Injectable()
export class UserRelayService {
  private readonly logger = new Logger(UserRelayService.name);
  private readonly enabled: boolean;
  /** 启用中镜像规则的备份群缓存（见 resolveTargetChatId） */
  private cachedRuleTarget = '';
  private cachedRuleAtMs = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly userClient: TelegramUserClientService,
    /**
     * 镜像规则仓库：**中继目标群的唯一权威来源**。
     *
     * 用 `@Optional()`：大量单测直接 new 本服务；缺失时 `resolveTargetChatId()` 返回空串，
     * 由调用方按 `target_missing`（`blocked_target_chat`）收口，不再回退归档群。
     */
    @Optional() @InjectRepository(TelegramMirrorRule)
    private readonly rules: Repository<TelegramMirrorRule> | null = null,
  ) {
    this.enabled = (this.configService.get<string>('TELEGRAM_USER_RELAY_ENABLED') || '')
      .trim()
      .toLowerCase() === 'true';
    // 启动期高可见度信号：开关已开但客户端不可用属于「配置了却完全不可用」，
    // 只靠运行期 warn 会被淹没；这里显式报错让运维在启动日志里就能发现。
    // 注意：策略 A 已移除，此处**不存在**任何降级路径，扩散会明确失败并等待修复。
    if (this.enabled && !this.userClient.isAvailable()) {
      this.logger.error(
        `TELEGRAM_USER_RELAY_ENABLED=true 但 MTProto 客户端不可用（${this.userClient.unavailableReason() ?? '未知原因'}）：`
        + '副本扩散将保持阻塞（blocked_user_client），不会发生任何字节二次传输。',
      );
    }
  }

  /**
   * 是否具备用户账号中继能力。
   *
   * 判据只有两个同步可得的事实：开关已开 + MTProto 客户端可加载。
   * **刻意不把「已有可用用户账号」纳入**：账号列表是异步查库的，冷缓存时返回 false 会让
   * 预检与首次执行给出错误的「未配置」结论。真实账号可用性由执行器
   * （`TelegramUserCopyService`）判定并给出 `no_user_account`——宁可给出可诊断失败，
   * 也不要「看起来已配置但永远不走中继」。
   */
  isConfigured(): boolean {
    return this.enabled && this.userClient.isAvailable();
  }

  /**
   * 解析中继目标群（副本可见群）。
   *
   * **唯一权威来源：启用中的镜像规则 `targetChatId`**（规则启用前必须通过真实权限探测）。
   * 刻意**不再回退** `TELEGRAM_ARCHIVE_CHAT_ID` / `TELEGRAM_CHAT_ID`：归档群只是审计转发
   * 目的地，它的成员与权限没有经过「全部 Bot 可见」的校验，用它做副本可见群会让中继
   * 「转发成功但无人认领」——表现为副本数长期为 0，而日志里全是成功记录。
   * 未配置启用规则时返回空串，由调用方按 `target_missing` 收口为 `blocked_target_chat`。
   */
  async resolveTargetChatId(): Promise<string> {
    if (!this.rules) return '';
    try {
      if (!this.cachedRuleFresh()) {
        const rule = await this.rules.findOne({ where: { enabled: true } });
        this.cachedRuleTarget = (rule?.targetChatId || '').trim();
        this.cachedRuleAtMs = Date.now();
      }
      return this.cachedRuleTarget;
    } catch (error) {
      this.logger.warn(
        `镜像备份群读取失败（本轮按目标群缺失处理，不再回退归档群）：`
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return '';
    }
  }

  private cachedRuleFresh(): boolean {
    return this.cachedRuleAtMs > 0 && Date.now() - this.cachedRuleAtMs < MIRROR_TARGET_CACHE_TTL_MS;
  }

  /** 是否已开启中继开关（用于报告与排障，不代表可用） */
  isEnabledByConfig(): boolean {
    return this.enabled;
  }
}
