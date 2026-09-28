import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  TelegramMirrorRule,
  TelegramMirrorTestStatus,
} from '../common/entities/telegram-mirror-rule.entity';
import { TelegramMirrorTask } from '../common/entities/telegram-mirror-task.entity';
import { AuditService } from '../common/services/audit.service';
import { TelegramAccountsService } from '../telegram-accounts/telegram-accounts.service';
import { TelegramAccountClientService } from '../telegram-account-pool/telegram-account-client.service';
import { TelegramUserClientService } from '../telegram-user/telegram-user-client.service';

/**
 * 规则可编辑字段。
 *
 * 没有 `mode` / `fallbackMode`：副本扩散**只有**「用户账号从主群服务端转发到镜像群」
 * 一条链路，不存在「Bot 重新上传」，因此不存在模式选择，也不存在降级策略
 * （表列保留不删：旧版本程序回退运行时不得因为缺列而启动失败）。
 */
export interface MirrorRuleInput {
  name?: string;
  sourceChatId?: string;
  targetChatId?: string;
  preferredAccountId?: string | null;
  includeWebUploads?: boolean;
  includeBotInboundFiles?: boolean;
}

export interface MirrorRuleTestResult {
  status: TelegramMirrorTestStatus;
  summary: string;
  details: Array<{ chat: 'source' | 'target'; ok: boolean; title: string | null; type: string | null; error?: string }>;
}

/**
 * 主群解析结论。
 *
 * 主群 = 启用中镜像规则的 `sourceChatId`，是副本扩散**唯一**的中转落点：
 * 持有源消息的 Bot 先把消息转发进主群，用户账号再从主群中继到各镜像群。
 * 所有启用规则必须共用同一个主群，否则同一份文件会有多个中转落点，
 * 「主群锚点」的共享语义（一个文件一行锚点）直接失效——因此这里**明确失败**，
 * 不猜、不取第一条。
 */
export type MirrorMainChatResolution =
  | { ok: true; chatId: string }
  | { ok: false; code: 'main_chat_missing' | 'main_chat_conflict'; summary: string };

/** 备份群集合缓存 TTL：入站判定是热路径，但规则变更不频繁 */
const TARGET_CHAT_CACHE_TTL_MS = 30_000;

/**
 * 镜像规则配置（多规则：**每条启用规则对应一个镜像群**）。
 *
 * 链路语义：`sourceChatId` 是所有启用规则**共用**的「主群」（中转落点），
 * `targetChatId` 是各自的「镜像群」。副本扩散对每条启用规则各建一条任务。
 *
 * 强校验（服务端权威，前端只是提示）：
 * - `sourceChatId !== targetChatId`：主群与镜像群必须分离，否则备份没有意义；
 * - 镜像群**不得**等于任一 Bot 账号的主存储 Chat：否则消息归属与清理语义混淆；
 * - 启用中的规则必须**共用同一个主群**（`sourceChatId` 一致）：主群锚点是
 *   「一个文件一行」的共享落点，多主群会让同一文件被搬运多次；
 * - 启用前必须通过一次真实权限探测（`lastTestStatus='ok'`），
 *   避免「打开开关后所有任务批量 blocked」。
 */
@Injectable()
export class TelegramMirrorConfigService {
  private readonly logger = new Logger(TelegramMirrorConfigService.name);
  /** 备份群 chat id 缓存（见 listTargetChatIds） */
  private cachedTargetChats: string[] = [];
  private targetChatsAtMs = 0;
  /** 主群 chat id 缓存（见 listSourceChatIds） */
  private cachedSourceChats: string[] = [];
  private sourceChatsAtMs = 0;

  constructor(
    @InjectRepository(TelegramMirrorRule)
    private readonly repo: Repository<TelegramMirrorRule>,
    @InjectRepository(TelegramMirrorTask)
    private readonly tasks: Repository<TelegramMirrorTask>,
    private readonly accounts: TelegramAccountsService,
    private readonly client: TelegramAccountClientService,
    private readonly userClient: TelegramUserClientService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 单规则视图（兼容：优先启用中的规则，否则最近更新的一条）。
   *
   * 多规则链路请使用 `listRules()` / `listEnabledRules()`；本方法只服务于
   * 「概览页展示一条样例规则」这类不需要全量语义的场景。
   */
  async getRule(): Promise<TelegramMirrorRule | null> {
    const enabled = await this.repo.findOne({ where: { enabled: true } });
    if (enabled) return enabled;
    const [latest] = await this.repo.find({ order: { updatedAt: 'DESC' }, take: 1 });
    return latest ?? null;
  }

  /** 全部规则（后台列表；创建时间升序，与扩散建单顺序一致，便于日志对照） */
  async listRules(): Promise<TelegramMirrorRule[]> {
    return this.repo.find({ order: { createdAt: 'ASC', id: 'ASC' } });
  }

  async getRuleById(id: string): Promise<TelegramMirrorRule | null> {
    return this.repo.findOne({ where: { id } });
  }

  /**
   * **启用中**的规则列表（多镜像群：每条启用规则对应一个镜像群）。
   *
   * 排序固定为 `createdAt ASC`：扩散任务逐条建单，顺序稳定才能让后台与日志可对照。
   */
  async listEnabledRules(): Promise<TelegramMirrorRule[]> {
    return this.repo.find({ where: { enabled: true }, order: { createdAt: 'ASC', id: 'ASC' } });
  }

  /**
   * 主群解析（副本扩散唯一中转落点）。
   *
   * 口径：
   * - 没有启用规则 → `main_chat_missing`（扩散不该发生，任务侧收敛为 blocked）；
   * - 启用规则的 `sourceChatId` 为空 → `main_chat_missing`；
   * - 启用规则之间 `sourceChatId` 不一致 → `main_chat_conflict`（必须人工统一，
   *   否则「一个文件一行主群锚点」的共享语义失效）。
   */
  async resolveMainChatId(): Promise<MirrorMainChatResolution> {
    const rules = await this.listEnabledRules();
    if (rules.length === 0) {
      return {
        ok: false,
        code: 'main_chat_missing',
        summary: '没有启用中的镜像规则，未配置主群（中转落点）',
      };
    }

    const sources = Array.from(new Set(
      rules.map((rule) => (rule.sourceChatId || '').trim()).filter((id) => id.length > 0),
    ));
    if (sources.length === 0) {
      return {
        ok: false,
        code: 'main_chat_missing',
        summary: '启用中的镜像规则未配置源群（主群），副本扩散缺少中转落点',
      };
    }
    if (sources.length > 1) {
      return {
        ok: false,
        code: 'main_chat_conflict',
        summary: `启用中的镜像规则配置了 ${sources.length} 个不同的源群（主群）：${sources.join('、')}；`
          + '所有启用规则必须共用同一个主群，请统一后再启用',
      };
    }
    return { ok: true, chatId: sources[0] };
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

  /**
   * **启用中**规则的备份群 chat id 集合（去重、去空）。
   *
   * 与 `listTargetChatIds()` 的区别：这里只返回 `enabled=true` 的规则目标群。
   * 副本扩散的「中继目标群」唯一权威就是启用中的规则（见 `UserRelayService.resolveTargetChatId`），
   * 因此入站链路判断「这条消息是不是中继过来的」必须用同一口径：
   * 用未启用规则的目标群判定，会把普通备份群消息误标成 `relayed`，
   * 让后台把「非中继来源」统计成「中继已生效」——观测数据直接失真。
   *
   * 读不到规则时返回空数组：宁可漏标（记为 `inbound`），也不要误标。
   */
  /**
   * 主群集合（全部规则的 `sourceChatId`，去重、忽略空值）。
   *
   * 用途：入站链路的**归档转发放大抑制**——主群是副本扩散的中转落点，群内每条消息
   * 会被群内每个 Bot 各收到一次，逐个归档转发会按 Bot 数（N）放大。
   * 这里刻意覆盖**全部规则（含未启用）**：规则临时停用不代表已落在主群里的历史消息
   * 可以再被放大一轮。
   */
  async listSourceChatIds(): Promise<string[]> {
    // 与 `listTargetChatIds` 同一口径：缓存**命中**才走快路径；空结果不写时间戳，
    // 让「规则还没配置」时的下一次调用仍然真实查库。
    if (this.sourceChatsFresh()) return this.cachedSourceChats;
    try {
      const rows = await this.repo.find({ select: ['sourceChatId'] });
      this.cachedSourceChats = Array.from(new Set(
        rows.map((row) => (row.sourceChatId || '').trim()).filter((id) => id.length > 0),
      ));
      this.sourceChatsAtMs = this.cachedSourceChats.length > 0 ? Date.now() : 0;
    } catch (error) {
      // 读取失败时沿用上次结果：宁可沿用可能过期的抑制集合，也不要让 N 倍放大重新出现
      this.logger.warn(
        `主群集合读取失败（沿用上次结果，避免归档抑制失效导致 N 倍放大）：`
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.cachedSourceChats;
  }

  private sourceChatsFresh(): boolean {
    return this.sourceChatsAtMs > 0 && Date.now() - this.sourceChatsAtMs < TARGET_CHAT_CACHE_TTL_MS;
  }

  async listEnabledTargetChatIds(): Promise<string[]> {
    try {
      const rows = await this.repo.find({ where: { enabled: true }, select: ['targetChatId'] });
      return Array.from(
        new Set(rows.map((row) => (row.targetChatId || '').trim()).filter((id) => id.length > 0)),
      );
    } catch (error) {
      this.logger.warn(
        `启用中镜像规则目标群读取失败（按「非中继来源」处理）：`
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * 新建规则。
   *
   * 一律以**停用**状态创建：源群/镜像群需要一次真实权限探测（`lastTestStatus='ok'`）
   * 才能启用，避免「刚建好就打开开关 → 所有扩散任务批量 blocked」。
   */
  async create(input: MirrorRuleInput, actorId: string): Promise<TelegramMirrorRule> {
    const next = this.repo.create({
      enabled: false,
      name: '镜像规则',
      sourceChatId: '',
      targetChatId: '',
      preferredAccountId: null,
      includeWebUploads: true,
      includeBotInboundFiles: true,
      lastTestStatus: 'untested',
    });
    return this.applyAndSave(next, input, actorId, false);
  }

  /** 更新指定规则（不存在则 404；改名等不涉及源/目标的改动不会清空权限测试结论） */
  async updateRule(ruleId: string, input: MirrorRuleInput, actorId: string): Promise<TelegramMirrorRule> {
    const rule = await this.getRuleById(ruleId);
    if (!rule) throw new NotFoundException('镜像规则不存在');
    return this.applyAndSave(rule, input, actorId, true);
  }

  /**
   * 删除规则。
   *
   * 拒绝条件（都必须由管理员先处理，不静默级联）：
   * - 规则仍在启用：删除启用中的规则会让在途任务失去目标；
   * - 仍有在途任务（queued/running/retrying）：留待收尾，避免把「正在扩散」变成静默中断。
   *
   * 已结束的历史任务保留 ruleId（不建外键），仅供追溯；消费者遇到规则缺失会标记 blocked。
   */
  async removeRule(ruleId: string, actorId: string): Promise<void> {
    const rule = await this.getRuleById(ruleId);
    if (!rule) throw new NotFoundException('镜像规则不存在');
    if (rule.enabled) {
      throw new BadRequestException('规则正在启用中，请先停用再删除（避免在途任务失去目标）');
    }
    const pending = await this.tasks.count({ where: { ruleId, status: In(['queued', 'running', 'retrying']) } });
    if (pending > 0) {
      throw new BadRequestException(`该规则还有 ${pending} 个在途任务（排队/执行中/重试中），请等待收尾后再删除`);
    }
    await this.repo.delete({ id: ruleId });
    this.audit.log({
      action: 'telegram_mirror_config_changed',
      userId: actorId,
      resourceType: 'telegram_mirror_rule',
      resourceId: ruleId,
      metadata: { deleted: true, name: rule.name, sourceChatId: rule.sourceChatId, targetChatId: rule.targetChatId },
    });
  }

  /** 字段赋值 + 校验 + 落库 + 审计（create 与 update 共用） */
  private async applyAndSave(
    next: TelegramMirrorRule,
    input: MirrorRuleInput,
    actorId: string,
    updating: boolean,
  ): Promise<TelegramMirrorRule> {
    if (input.name !== undefined) next.name = input.name.trim();
    if (input.sourceChatId !== undefined) next.sourceChatId = input.sourceChatId.trim();
    if (input.targetChatId !== undefined) next.targetChatId = input.targetChatId.trim();
    if (input.preferredAccountId !== undefined) next.preferredAccountId = input.preferredAccountId?.trim() || null;
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
        changed: updating ? Object.keys(input) : ['created', ...Object.keys(input)],
        name: saved.name,
        sourceChatId: saved.sourceChatId,
        targetChatId: saved.targetChatId,
        includeWebUploads: saved.includeWebUploads,
        includeBotInboundFiles: saved.includeBotInboundFiles,
        preferredAccountId: saved.preferredAccountId,
      },
    });
    return saved;
  }

  /**
   * 启用/停用指定规则。
   * 启用必须满足：源/镜像群已配置、两者不同、镜像群不是任何 Bot 的主存储 Chat、
   * 权限测试通过、且与其它启用规则**共用同一个主群**。
   */
  async setEnabled(ruleId: string, enabled: boolean, actorId: string): Promise<TelegramMirrorRule> {
    const rule = await this.getRuleById(ruleId);
    if (!rule) throw new NotFoundException('镜像规则不存在');
    if (enabled) {
      await this.validateShape(rule, {});
      if (rule.lastTestStatus !== 'ok') {
        throw new BadRequestException(
          '规则尚未通过主群/镜像群权限测试，无法启用；请先执行「测试权限」并在通过后再开启',
        );
      }
      await this.assertMainChatShared(rule);
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
        note: enabled ? undefined : '关闭只阻止新任务，已开始的镜像会正常收尾',
      },
    });
    return saved;
  }

  /** 真实权限探测：主群可读 + 镜像群可写（Bot 与用户账号分别验证） */
  async testRule(ruleId: string, actorId: string): Promise<MirrorRuleTestResult> {
    const rule = await this.getRuleById(ruleId);
    if (!rule) throw new NotFoundException('镜像规则不存在');
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

    // 用户账号路径是**唯一**执行路径，因此必须探测；失败不直接判死，但明确写入结论
    if (this.userClient.isAvailable()) {
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
    const relayHint = '；副本认领前提：镜像群内**每个 Bot 都需关闭隐私模式或设为管理员**，'
      + '且中继用户账号需同时是主群与镜像群成员';
    const base = ok
      ? `权限测试通过（Bot 账号 ${botProbe.accountId} 可访问主群与镜像群）`
      : failed
        .map((item) => `${item.chat === 'source' ? '主群' : '镜像群'}不可用：${item.error ?? '未知原因'}`)
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
    if (!rule.sourceChatId?.trim()) throw new BadRequestException('必须配置主群（源群，副本扩散的中转落点）');
    if (!rule.targetChatId?.trim()) throw new BadRequestException('必须配置镜像群（备份群）');
    if (rule.sourceChatId === rule.targetChatId) {
      throw new BadRequestException('镜像群不能与主群相同，中转落点与备份必须分离');
    }

    const botAccounts = await this.accounts.list({ type: 'bot', pageSize: 100 });
    const conflict = botAccounts.items.find((item) => item.primaryChatId === rule.targetChatId);
    if (conflict) {
      throw new BadRequestException(
        `镜像群不能是 Bot 账号「${conflict.name}」的主存储 Chat（会造成消息归属混淆）`,
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

  /**
   * 主群一致性：启用中的规则必须**共用同一个主群**。
   *
   * 主群锚点表按 `(ownerType, ownerId)` 唯一，一个文件只在主群有一个落点；
   * 若两条启用规则的源群不同，同一文件会被搬运多次（各自找自己的「主群」），
   * 既产生重复消息，也让「副本可见群」的归属无法解释——因此在这里直接拒绝启用。
   */
  private async assertMainChatShared(rule: TelegramMirrorRule): Promise<void> {
    const source = (rule.sourceChatId || '').trim();
    const others = (await this.repo.find({ where: { enabled: true }, select: ['id', 'sourceChatId'] }))
      .filter((item) => item.id !== rule.id)
      .map((item) => (item.sourceChatId || '').trim())
      .filter((id) => id.length > 0);
    const foreign = Array.from(new Set(others.filter((id) => id !== source)));
    if (foreign.length > 0) {
      throw new BadRequestException(
        `主群必须与其它启用规则一致：当前规则的主群是 ${source}，已启用规则使用的是 ${foreign.join('、')}；`
        + '所有启用规则共用同一个主群（副本扩散的中转落点），请先统一源群或停用冲突规则',
      );
    }
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
