import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TelegramMirrorFallbackMode,
  TelegramMirrorMode,
  TelegramMirrorRule,
  TelegramMirrorTestStatus,
} from '../common/entities/telegram-mirror-rule.entity';
import { AuditService } from '../common/services/audit.service';
import { TelegramAccountsService } from '../telegram-accounts/telegram-accounts.service';
import { TelegramAccountClientService } from '../telegram-account-pool/telegram-account-client.service';
import { TelegramUserClientService } from '../telegram-user/telegram-user-client.service';

export interface MirrorRuleInput {
  name?: string;
  sourceChatId?: string;
  targetChatId?: string;
  mode?: TelegramMirrorMode;
  preferredAccountId?: string | null;
  fallbackMode?: TelegramMirrorFallbackMode;
  includeWebUploads?: boolean;
  includeBotInboundFiles?: boolean;
}

export interface MirrorRuleTestResult {
  status: TelegramMirrorTestStatus;
  summary: string;
  details: Array<{ chat: 'source' | 'target'; ok: boolean; title: string | null; type: string | null; error?: string }>;
}

/** 备份群集合缓存 TTL：入站判定是热路径，但规则变更不频繁 */
const TARGET_CHAT_CACHE_TTL_MS = 30_000;

/**
 * 镜像规则配置（首发单规则）。
 *
 * 强校验（服务端权威，前端只是提示）：
 * - `sourceChatId !== targetChatId`：主存储群与备份群必须分离，否则备份没有意义；
 * - 备份群**不得**等于任一 Bot 账号的主存储 Chat：否则消息归属与清理语义混淆；
 * - 启用前必须通过一次真实权限探测（`lastTestStatus='ok'`），
 *   避免「打开开关后所有任务批量 blocked」。
 */
@Injectable()
export class TelegramMirrorConfigService {
  private readonly logger = new Logger(TelegramMirrorConfigService.name);
  /** 备份群 chat id 缓存（见 listTargetChatIds） */
  private cachedTargetChats: string[] = [];
  private targetChatsAtMs = 0;

  constructor(
    @InjectRepository(TelegramMirrorRule)
    private readonly repo: Repository<TelegramMirrorRule>,
    private readonly accounts: TelegramAccountsService,
    private readonly client: TelegramAccountClientService,
    private readonly userClient: TelegramUserClientService,
    private readonly audit: AuditService,
  ) {}

  /** 首发单规则：优先返回启用中的规则，否则返回最近更新的一条 */
  async getRule(): Promise<TelegramMirrorRule | null> {
    const enabled = await this.repo.findOne({ where: { enabled: true } });
    if (enabled) return enabled;
    const [latest] = await this.repo.find({ order: { updatedAt: 'DESC' }, take: 1 });
    return latest ?? null;
  }

  async getRuleById(id: string): Promise<TelegramMirrorRule | null> {
    return this.repo.findOne({ where: { id } });
  }

  /**
   * 全部「备份群」chat id 集合（去重、去空）。
   *
   * 用途：入站链路据此判断「这条群消息是否来自备份群」。来自备份群的消息只登记副本、
   * **不再向 `TELEGRAM_ARCHIVE_CHAT_ID` 归档转发**——否则副本可见群里的每条消息都会被
   * 群内每个 Bot 各转发一次，消息量与上游调用按 Bot 数（N）放大。
   *
   * 带短 TTL 缓存：该判定在每条群内文件消息上触发，不该每次都打库。
   */
  async listTargetChatIds(): Promise<string[]> {
    // 缓存**命中**才走快路径；未命中（含首次，`targetChatsAtMs=0`）必须查库。
    // 判据写反会退化成「永远返回空数组 + 永不查库」，让放大抑制静默失效。
    if (this.targetChatsFresh()) return this.cachedTargetChats;
    try {
      const rows = await this.repo.find({ select: ['targetChatId'] });
      this.cachedTargetChats = Array.from(
        new Set(rows.map((row) => (row.targetChatId || '').trim()).filter((id) => id.length > 0)),
      );
      this.targetChatsAtMs = Date.now();
    } catch (error) {
      this.logger.warn(
        `镜像备份群列表读取失败（将沿用上一次结果）：${error instanceof Error ? error.message : String(error)}`,
      );
      // 读不到时：有上次结果则沿用并短暂缓存（避免每条消息都打库），无结果则不刷新时间戳以便立即重试
      this.targetChatsAtMs = this.cachedTargetChats.length > 0 ? Date.now() : 0;
    }
    return this.cachedTargetChats;
  }

  private targetChatsFresh(): boolean {
    return this.targetChatsAtMs > 0 && Date.now() - this.targetChatsAtMs < TARGET_CHAT_CACHE_TTL_MS;
  }

  /** 创建或更新首发规则（不存在则创建；存在则按传入字段更新） */
  async upsert(input: MirrorRuleInput, actorId: string): Promise<TelegramMirrorRule> {
    const current = await this.getRule();
    const next: TelegramMirrorRule = current ?? this.repo.create({
      enabled: false,
      name: '默认镜像规则',
      sourceChatId: '',
      targetChatId: '',
      mode: 'bot_upload',
      preferredAccountId: null,
      fallbackMode: 'disabled',
      includeWebUploads: true,
      includeBotInboundFiles: false,
      lastTestStatus: 'untested',
    });

    if (input.name !== undefined) next.name = input.name.trim();
    if (input.sourceChatId !== undefined) next.sourceChatId = input.sourceChatId.trim();
    if (input.targetChatId !== undefined) next.targetChatId = input.targetChatId.trim();
    if (input.mode !== undefined) next.mode = input.mode;
    if (input.preferredAccountId !== undefined) next.preferredAccountId = input.preferredAccountId?.trim() || null;
    if (input.fallbackMode !== undefined) next.fallbackMode = input.fallbackMode;
    if (input.includeWebUploads !== undefined) next.includeWebUploads = input.includeWebUploads;
    if (input.includeBotInboundFiles !== undefined) next.includeBotInboundFiles = input.includeBotInboundFiles;

    await this.validateShape(next, input);
    // 源/目标变化后旧测试结论失效
    if (input.sourceChatId !== undefined || input.targetChatId !== undefined) {
      next.lastTestStatus = 'untested';
      next.lastTestSummary = null;
      next.lastTestedAt = null;
    }
    next.updatedBy = actorId;
    if (!next.createdBy) next.createdBy = actorId;

    const saved = await this.repo.save(next);
    this.audit.log({
      action: 'telegram_mirror_config_changed',
      userId: actorId,
      resourceType: 'telegram_mirror_rule',
      resourceId: saved.id,
      metadata: {
        changed: Object.keys(input),
        sourceChatId: saved.sourceChatId,
        targetChatId: saved.targetChatId,
        mode: saved.mode,
        fallbackMode: saved.fallbackMode,
        includeWebUploads: saved.includeWebUploads,
        includeBotInboundFiles: saved.includeBotInboundFiles,
        preferredAccountId: saved.preferredAccountId,
      },
    });
    return saved;
  }

  /**
   * 启用/停用规则。
   * 启用必须满足：源/目标已配置、两者不同、目标不是任何 Bot 的主存储 Chat、权限测试通过。
   */
  async setEnabled(enabled: boolean, actorId: string): Promise<TelegramMirrorRule> {
    const rule = await this.getRule();
    if (!rule) throw new NotFoundException('镜像规则尚未配置');
    if (enabled) {
      await this.validateShape(rule, {});
      if (rule.lastTestStatus !== 'ok') {
        throw new BadRequestException(
          '规则尚未通过源/目标权限测试，无法启用；请先执行「测试权限」并在通过后再开启',
        );
      }
      // 首发只允许一条启用规则：显式关闭其它规则，避免语义冲突
      await this.repo.update({ enabled: true }, { enabled: false });
    }
    rule.enabled = enabled;
    rule.updatedBy = actorId;
    const saved = await this.repo.save(rule);

    this.audit.log({
      action: enabled ? 'telegram_mirror_feature_enabled' : 'telegram_mirror_feature_disabled',
      userId: actorId,
      resourceType: 'telegram_mirror_rule',
      resourceId: saved.id,
      metadata: {
        sourceChatId: saved.sourceChatId,
        targetChatId: saved.targetChatId,
        mode: saved.mode,
        note: enabled ? undefined : '关闭只阻止新任务，已开始的镜像会正常收尾',
      },
    });
    return saved;
  }

  /** 真实权限探测：源群可读 + 备份群可写（Bot 与用户账号分别验证） */
  async testRule(actorId: string): Promise<MirrorRuleTestResult> {
    const rule = await this.getRule();
    if (!rule) throw new NotFoundException('镜像规则尚未配置');
    await this.validateShape(rule, {});

    const details: MirrorRuleTestResult['details'] = [];
    const botProbe = await this.pickBotForProbe(rule.preferredAccountId);
    if (!botProbe) {
      const summary = '没有可用的 Bot 账号（请先在账号池中添加并启用至少一个 Bot，或配置 TELEGRAM_BOT_TOKEN）';
      await this.markTest(rule.id, 'failed', summary);
      return { status: 'failed', summary, details };
    }

    for (const [role, chatId] of [['source', rule.sourceChatId], ['target', rule.targetChatId]] as const) {
      try {
        const chat = await this.client.getChat(botProbe.accountId, botProbe.token, chatId);
        details.push({ chat: role, ok: true, title: chat.title ?? null, type: chat.type ?? null });
      } catch (error) {
        details.push({
          chat: role,
          ok: false,
          title: null,
          type: null,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
        });
      }
    }

    // 用户账号路径（auto/user_copy 模式）额外验证一次；失败不直接判死，但明确写入结论
    if (rule.mode !== 'bot_upload' && this.userClient.isAvailable()) {
      try {
        const users = await this.accounts.resolveEnabledUserAccounts();
        if (users.length === 0) {
          details.push({ chat: 'source', ok: false, title: null, type: null, error: '没有可用的用户账号（未授权或未启用）' });
        } else {
          const user = users[0];
          const credentials = { apiId: user.apiId, apiHash: user.apiHash, session: user.session };
          for (const [role, chatId] of [['source', rule.sourceChatId], ['target', rule.targetChatId]] as const) {
            const access = await this.userClient.checkChatAccess(credentials, chatId);
            details.push({
              chat: role,
              ok: access.canWrite || role === 'source',
              title: access.title,
              type: access.type,
              error: access.canWrite || role === 'source' ? undefined : '用户账号无写入权限',
            });
          }
        }
      } catch (error) {
        details.push({
          chat: 'target',
          ok: false,
          title: null,
          type: null,
          error: `用户账号探测失败：${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`,
        });
      }
    }

    const ok = details.length > 0 && details.every((item) => item.ok);
    const failed = details.filter((item) => !item.ok);
    // 用户账号路径的**副本认领**前提无法在服务端验证（取决于群内每个 Bot 的隐私模式设置），
    // 因此在结论里显式提示：这是运维必须在 Telegram 侧完成的动作，漏做时表现为
    // 「镜像成功但副本数不增长、下载仍集中在单账号」。
    const relayHint = rule.mode === 'bot_upload'
      ? ''
      : '；副本认领前提：备份群内**每个 Bot 都需关闭隐私模式或设为管理员**，'
        + '且中继用户账号需同时是源群与备份群成员';
    const base = ok
      ? `权限测试通过（Bot 账号 ${botProbe.accountId} 可访问源群与备份群）`
      : failed
        .map((item) => `${item.chat === 'source' ? '源群' : '备份群'}不可用：${item.error ?? '未知原因'}`)
        .join('；');
    const summary = `${base}${relayHint}`.slice(0, 500);
    await this.markTest(rule.id, ok ? 'ok' : 'failed', summary);

    this.audit.log({
      action: 'telegram_mirror_rule_tested',
      userId: actorId,
      resourceType: 'telegram_mirror_rule',
      resourceId: rule.id,
      metadata: { ok, sourceChatId: rule.sourceChatId, targetChatId: rule.targetChatId, details },
    });
    return { status: ok ? 'ok' : 'failed', summary, details };
  }

  async markTest(ruleId: string, status: TelegramMirrorTestStatus, summary: string): Promise<void> {
    await this.repo.update({ id: ruleId }, {
      lastTestStatus: status,
      lastTestSummary: summary.slice(0, 500),
      lastTestedAt: new Date(),
    });
  }

  /** 形状校验（不触发任何网络调用） */
  private async validateShape(rule: TelegramMirrorRule, input: MirrorRuleInput): Promise<void> {
    if (!rule.name?.trim()) throw new BadRequestException('规则名称不能为空');
    if (!rule.sourceChatId?.trim()) throw new BadRequestException('必须配置源群（主存储群）');
    if (!rule.targetChatId?.trim()) throw new BadRequestException('必须配置备份群');
    if (rule.sourceChatId === rule.targetChatId) {
      throw new BadRequestException('备份群不能与源群相同，主存储与备份必须分离');
    }

    const botAccounts = await this.accounts.list({ type: 'bot', pageSize: 100 });
    const conflict = botAccounts.items.find((item) => item.primaryChatId === rule.targetChatId);
    if (conflict) {
      throw new BadRequestException(
        `备份群不能是 Bot 账号「${conflict.name}」的主存储 Chat（会造成消息归属混淆）`,
      );
    }

    if (rule.preferredAccountId) {
      const account = await this.accounts.findById(rule.preferredAccountId);
      if (!account) throw new BadRequestException('优先账号不存在');
      if (!account.enabled || account.status === 'revoked' || account.status === 'pending_auth') {
        throw new BadRequestException('优先账号当前不可用（未启用/已撤销/待授权）');
      }
    }
    void input;
  }

  /** 探测用 Bot：优先规则指定账号，其次任意启用的面板账号，最后默认单账号链路 */
  private async pickBotForProbe(preferredAccountId: string | null): Promise<{ accountId: string; token: string } | null> {
    const panel = await this.accounts.resolveEnabledBotAccounts();
    if (preferredAccountId) {
      const preferred = panel.find(
        (item) => item.accountId === preferredAccountId || item.id === preferredAccountId,
      );
      if (preferred) return { accountId: preferred.accountId, token: preferred.token };
    }
    if (panel.length > 0) return { accountId: panel[0].accountId, token: panel[0].token };

    const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (token.includes(':')) {
      const accountId = token.split(':')[0];
      this.logger.log(`面板无可用 Bot 账号，权限测试使用默认单账号 Bot（${accountId}）`);
      return { accountId, token };
    }
    return null;
  }
}
