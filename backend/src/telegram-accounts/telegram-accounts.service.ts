import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TelegramAccount,
  TelegramAccountCapabilities,
  TelegramAccountStatus,
} from '../common/entities/telegram-account.entity';
import { AuditStatus } from '../common/entities/audit-log.entity';
import { AuditService } from '../common/services/audit.service';
import { TelegramAccountPoolService } from '../telegram-account-pool/telegram-account-pool.service';
import { TelegramAccountCredentialService } from './telegram-account-credential.service';
import { TelegramAccountFeatureService, TelegramAccountFeatureState } from './telegram-account-feature.service';
import { TelegramAccountProbeService } from './telegram-account-probe.service';
import { TelegramUserClientService } from '../telegram-user/telegram-user-client.service';
import {
  CreateBotAccountDto,
  CreateUserAccountDto,
  RotateBotCredentialDto,
  RotateUserCredentialDto,
  UpdateTelegramAccountDto,
} from './telegram-account.dto';
import {
  TelegramAccountRuntimeView,
  TelegramAccountView,
  TelegramEnvAccountView,
  toAccountView,
  toEnvAccountView,
  toRuntimeView,
} from './telegram-account-view';

/** 凭据载荷（落库前整体加密；明文只在本进程内短暂存在） */
export interface TelegramAccountCredentialPayload {
  /** Bot 账号 */
  token?: string;
  /** 用户账号 */
  apiId?: number;
  apiHash?: string;
  session?: string;
  phoneNumber?: string;
}

/** 账号池消费的最小账号形状（解密后的凭据只在内存中使用） */
export interface PoolBotAccount {
  id: string;
  accountId: string;
  token: string;
  chatId: string;
  weight: number;
  maxInflight: number;
}

/** 环境变量账号探测结论（脱敏；不含 Token） */
export interface EnvAccountProbeResult {
  ok: boolean;
  message: string;
  capabilities: TelegramAccount['capabilities'];
  chatTitle: string | null;
  chatType: string | null;
  errorCode: string | null;
}

export interface AccountPoolOverview {
  feature: TelegramAccountFeatureState;
  credentialCryptoAvailable: boolean;
  userClientAvailable: boolean;
  userClientUnavailableReason: string | null;
  counts: {
    total: number;
    bot: number;
    user: number;
    enabled: number;
    active: number;
    degraded: number;
    disabled: number;
    revoked: number;
    pendingAuth: number;
  };
  /**
   * 账号池运行态摘要（来自进程内注册表）。
   * 用途：区分「后台有账号」与「账号池真的生效」，并让管理员看到环境变量主 Bot。
   */
  pool: {
    enabled: boolean;
    inactiveReason: string | null;
    /** 环境变量主 Bot 的账号 id（未配置 `TELEGRAM_BOT_TOKEN` 时为 null） */
    primaryAccountId: string | null;
    /** 池内注册账号总数（含环境变量与数据库账号） */
    accountCount: number;
    /** 其中来自环境变量的账号数 */
    envAccountCount: number;
  };
  /** 环境变量账号（主 Bot 与 TELEGRAM_ACCOUNT_POOL 配置项）的只读脱敏视图 */
  envAccounts: TelegramEnvAccountView[];
  precheck: Array<{ id: string; ok: boolean; hint: string }>;
}

export interface TelegramAccountListQuery {
  type?: string;
  status?: string;
  enabled?: string;
  keyword?: string;
  /**
   * 是否把「已撤销」（软删除）账号一并返回。默认 `false`：列表隐藏 revoked 行，
   * 与产品「删除=撤销后不再出现」的语义一致；显式 `true` 或显式筛选 `status=revoked`
   * 时排除条件让位（详见 `list()`）。
   */
  includeRevoked?: boolean;
  page?: number;
  pageSize?: number;
}

const MAX_PAGE_SIZE = 100;
const FAILURE_SUMMARY_LIMIT = 500;

/** 合法账号状态集合（与 `TelegramAccountStatus` 对齐）：非法 `status` 查询参数直接忽略 */
const TELEGRAM_ACCOUNT_STATUSES: readonly TelegramAccountStatus[] = [
  'pending_auth',
  'active',
  'disabled',
  'degraded',
  'revoked',
  'draining',
];

/**
 * Telegram 账号主数据服务（Bot 与用户账号统一生命周期）。
 *
 * 关键设计：
 * - **凭据只以密文落库**：明文 Token/session 只在内存中短暂存在，接口与审计永不回显；
 * - **创建/轮换即验证**：Bot 必须 `getMe`（+ 可选主存储 Chat `getChat`）通过才落库，
 *   不允许「先存字符串、等任务失败才发现配置错误」；
 * - **删除是撤销而非物理删除**：状态转 `revoked`、凭据清空、停止参与新任务，
 *   历史副本与审计保留（远端文件不自动删除）；
 * - **关闭只阻止新任务**：`enabled=false` 不影响已开始的上传/下载。
 */
@Injectable()
export class TelegramAccountsService {
  private readonly logger = new Logger(TelegramAccountsService.name);

  constructor(
    @InjectRepository(TelegramAccount)
    private readonly repo: Repository<TelegramAccount>,
    private readonly credentials: TelegramAccountCredentialService,
    private readonly feature: TelegramAccountFeatureService,
    private readonly probe: TelegramAccountProbeService,
    private readonly userClient: TelegramUserClientService,
    private readonly audit: AuditService,
    /**
     * 账号池（只读取注册表做去重与运行态展示）。
     *
     * 依赖方向：accounts → pool 为单向（由 `TelegramAccountsModule` imports 保证）；
     * 反向的数据来源通过 `registerAccountSource` 回调注入，二者不成环。
     */
    private readonly pool: TelegramAccountPoolService,
  ) {}

  // ---------------- 查询 ----------------

  async list(query: TelegramAccountListQuery): Promise<{
    items: TelegramAccountView[];
    total: number;
    /** 环境变量账号只读视图（不占数据库分页；用户页签恒为空数组） */
    envAccounts: TelegramEnvAccountView[];
  }> {
    const page = Number.isSafeInteger(query.page) && (query.page as number) > 0 ? Number(query.page) : 1;
    const rawSize = Number.isSafeInteger(query.pageSize) && (query.pageSize as number) > 0 ? Number(query.pageSize) : 20;
    const pageSize = Math.min(rawSize, MAX_PAGE_SIZE);

    const builder = this.repo.createQueryBuilder('account')
      // 只用于判断「凭据是否已配置」，内容永不进入视图
      .addSelect('account.credentialCiphertext')
      .orderBy('account.createdAt', 'DESC');

    if (query.type === 'bot' || query.type === 'user') {
      builder.andWhere('account.type = :type', { type: query.type });
    }
    // 收口到合法状态集合：非法 status 参数忽略（不拼进 SQL，避免无意义查询）
    const status = TELEGRAM_ACCOUNT_STATUSES.find((item) => item === query.status);
    if (status) {
      builder.andWhere('account.status = :status', { status });
    }
    // 默认隐藏已撤销（软删除）账号；显式筛选 revoked 或 includeRevoked=true 时排除条件让位，
    // 否则「已撤销」筛选会恒为空。status 为其它具体值时仍排除 revoked。
    const includeRevoked = query.includeRevoked === true || status === 'revoked';
    if (!includeRevoked) {
      builder.andWhere('account.status != :revokedStatus', { revokedStatus: 'revoked' });
    }
    if (query.enabled === 'true' || query.enabled === 'false') {
      builder.andWhere('account.enabled = :enabled', { enabled: query.enabled === 'true' });
    }
    if (query.keyword && query.keyword.trim()) {
      builder.andWhere('(account.name LIKE :kw OR account.externalId LIKE :kw)', {
        kw: `%${query.keyword.trim().slice(0, 64)}%`,
      });
    }

    const [rows, total] = await builder
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return {
      items: rows.map((account) => {
        const runtime = this.runtimeFor(account);
        return toAccountView(account, {
          credentialConfigured: Boolean(account.credentialCiphertext),
          runtime,
          source: this.sourceFor(account, runtime),
        });
      }),
      total,
      // 环境变量账号不占用数据库分页：Bot 页签需要独立只读区展示（用户页签没有池内运行态）
      envAccounts: query.type === 'user' ? [] : this.envAccounts(),
    };
  }

  async detail(id: string): Promise<TelegramAccountView> {
    const account = await this.findWithCredential(id);
    if (!account) throw new NotFoundException('账号不存在');
    const runtime = this.runtimeFor(account);
    return toAccountView(account, {
      credentialConfigured: Boolean(account.credentialCiphertext),
      runtime,
      source: this.sourceFor(account, runtime),
    });
  }

  /**
   * 账号池运行态（按 Bot 的 `externalId` 与池 id 对齐）。
   *
   * 为什么用 externalId：账号池的账号 id 对 Bot 而言就是 Bot ID（token 数字前缀），
   * 环境变量账号与数据库账号因此可以在同一命名空间里对齐、去重与合并展示。
   * 用户账号不参与账号池，运行态恒为 null。
   */
  private runtimeFor(account: TelegramAccount): TelegramAccountRuntimeView | null {
    if (account.type !== 'bot' || !account.externalId) return null;
    const snapshot = this.pool.runtimeView(account.externalId);
    return snapshot ? toRuntimeView(snapshot) : null;
  }

  /** 配置来源：同一 Bot 既在数据库又被环境变量注册时标记 `both`（提示后台不要重复维护密钥） */
  private sourceFor(account: TelegramAccount, runtime: TelegramAccountRuntimeView | null): 'panel' | 'both' {
    if (!runtime || account.type !== 'bot' || !account.externalId) return 'panel';
    return this.pool.isEnvAccount(account.externalId) ? 'both' : 'panel';
  }

  /** 环境变量账号（主 Bot 与 `TELEGRAM_ACCOUNT_POOL` 配置项）的只读脱敏视图 */
  private envAccounts(): TelegramEnvAccountView[] {
    return this.pool.snapshot().accounts
      .filter((account) => account.source !== 'panel')
      .map((account) => toEnvAccountView(account));
  }

  async overview(): Promise<AccountPoolOverview> {
    const [feature, rows] = await Promise.all([
      this.feature.getState(),
      this.repo.find(),
    ]);
    const count = (predicate: (account: TelegramAccount) => boolean): number => rows.filter(predicate).length;
    const counts = {
      total: rows.length,
      bot: count((account) => account.type === 'bot'),
      user: count((account) => account.type === 'user'),
      enabled: count((account) => account.enabled),
      active: count((account) => account.status === 'active'),
      degraded: count((account) => account.status === 'degraded'),
      disabled: count((account) => account.status === 'disabled'),
      revoked: count((account) => account.status === 'revoked'),
      pendingAuth: count((account) => account.status === 'pending_auth'),
    };
    const usable = count((account) => account.enabled && (account.status === 'active' || account.status === 'degraded'));
    const userClientAvailable = this.userClient.isAvailable();
    const poolSnapshot = this.pool.snapshot();
    const envAccounts = poolSnapshot.accounts
      .filter((account) => account.source !== 'panel')
      .map((account) => toEnvAccountView(account));
    const primaryAccountId = this.pool.primaryAccountId();

    return {
      feature,
      credentialCryptoAvailable: this.credentials.isAvailable(),
      userClientAvailable,
      userClientUnavailableReason: this.userClient.unavailableReason(),
      counts,
      pool: {
        enabled: poolSnapshot.enabled,
        inactiveReason: poolSnapshot.inactiveReason,
        primaryAccountId,
        accountCount: poolSnapshot.accounts.length,
        envAccountCount: envAccounts.length,
      },
      envAccounts,
      precheck: [
        {
          id: 'credential_crypto',
          ok: this.credentials.isAvailable(),
          hint: '未配置 TELEGRAM_ACCOUNT_ENCRYPTION_KEY（32 字节 base64/hex），账号创建与轮换会被拒绝',
        },
        {
          id: 'usable_account',
          ok: usable > 0 || envAccounts.length > 0,
          hint: '至少需要一个已启用且非 revoked/pending_auth 的账号（或环境变量主 Bot）才能开启账号池',
        },
        {
          id: 'primary_bot',
          ok: Boolean(primaryAccountId),
          hint: primaryAccountId
            ? `环境变量主 Bot 已注册为只读账号（${primaryAccountId}）；密钥轮换请改 .env，后台不提供编辑/删除`
            : '未配置 TELEGRAM_BOT_TOKEN：没有环境变量主 Bot，后台账号全部来自数据库',
        },
        {
          id: 'env_storage_chat',
          ok: envAccounts.every((account) => account.runtime.storageConfigured),
          hint: '环境变量账号未配置存储 Chat（TELEGRAM_CHAT_ID）：该账号只参与下载回源，不会被选为上传/镜像目标',
        },
        {
          id: 'user_client',
          ok: userClientAvailable,
          hint: 'MTProto 客户端不可用：用户账号授权与无源复制将 fail-closed（仅 Bot 路径可用）',
        },
        {
          id: 'single_instance',
          ok: (process.env.DEPLOYMENT_MODE || '').trim().toLowerCase() !== 'multi',
          hint: '账号池与镜像任务只支持单后端实例（DEPLOYMENT_MODE=multi 已被启动预检拒绝）',
        },
      ],
    };
  }

  // ---------------- 创建 ----------------

  async createBot(dto: CreateBotAccountDto, actorId: string): Promise<TelegramAccountView> {
    this.assertCryptoAvailable('创建 Bot 账号');
    const botId = dto.token.split(':')[0];
    // 环境变量是密钥管理边界：同一 Token 已由 `.env` 注册时直接拒绝，
    // 否则会出现「后台新增成功、实际被环境变量账号屏蔽」的双账号假象。
    if (this.pool.isEnvTokenRegistered(dto.token)) {
      throw new ConflictException(
        '该 Bot Token 已由环境变量账号（主 Bot 或账号池配置）注册，后台只读；'
        + '请改用其它 Bot，或先从 .env 移除该账号',
      );
    }
    await this.assertExternalIdFree('bot', botId);

    const probe = await this.probe.probeBot(dto.token, dto.primaryChatId ?? null);
    if (!probe.ok) {
      // 创建失败不落库：避免留下「看起来存在但不可用」的账号
      throw new BadRequestException(`Bot 校验失败，账号未创建：${probe.error ?? '未知原因'}`);
    }

    const ciphertext = this.credentials.encryptCredential({ token: dto.token });
    if (!ciphertext) throw new BadRequestException('凭据加密不可用，已拒绝以明文保存 Token');

    const account = this.repo.create({
      type: 'bot',
      name: dto.name.trim(),
      externalId: botId,
      status: 'active',
      enabled: true,
      weight: dto.weight ?? 1,
      maxInflight: dto.maxInflight ?? 8,
      primaryChatId: dto.primaryChatId?.trim() || null,
      credentialCiphertext: ciphertext,
      credentialVersion: this.credentials.cipherVersion(),
      capabilities: probe.capabilities,
      note: sanitizeNote(dto.note),
      lastHealthCheckAt: new Date(),
      lastSuccessAt: new Date(),
      createdBy: actorId,
      updatedBy: actorId,
    });
    const saved = await this.repo.save(account);
    this.audit.log({
      action: 'telegram_account_created',
      userId: actorId,
      resourceType: 'telegram_account',
      resourceId: saved.id,
      metadata: {
        type: 'bot',
        externalIdMasked: maskTail(botId),
        primaryChatId: saved.primaryChatId,
        chatType: probe.chatType,
        capabilities: probe.capabilities,
      },
    });
    return toAccountView(saved, { credentialConfigured: true });
  }

  async createUser(dto: CreateUserAccountDto, actorId: string): Promise<TelegramAccountView> {
    this.assertCryptoAvailable('创建用户账号');
    const ciphertext = this.credentials.encryptCredential({
      apiId: dto.apiId,
      apiHash: dto.apiHash,
      phoneNumber: dto.phoneNumber ?? '',
    });
    if (!ciphertext) throw new BadRequestException('凭据加密不可用，已拒绝以明文保存 API 凭据');

    const account = this.repo.create({
      type: 'user',
      name: dto.name.trim(),
      externalId: null,
      status: 'pending_auth',
      // 用户账号在授权完成并探测通过前不参与任何任务
      enabled: false,
      weight: 1,
      maxInflight: 2,
      primaryChatId: null,
      credentialCiphertext: ciphertext,
      credentialVersion: this.credentials.cipherVersion(),
      capabilities: null,
      note: sanitizeNote(dto.note),
      createdBy: actorId,
      updatedBy: actorId,
    });
    const saved = await this.repo.save(account);
    this.audit.log({
      action: 'telegram_account_created',
      userId: actorId,
      resourceType: 'telegram_account',
      resourceId: saved.id,
      metadata: {
        type: 'user',
        status: saved.status,
        // 手机号只记录脱敏摘要
        phoneMasked: maskTail(dto.phoneNumber ?? ''),
        userClientAvailable: this.userClient.isAvailable(),
      },
    });
    return toAccountView(saved, { credentialConfigured: true });
  }

  // ---------------- 更新 / 启停 / 删除 ----------------

  async update(id: string, dto: UpdateTelegramAccountDto, actorId: string): Promise<TelegramAccountView> {
    const account = await this.findWithCredential(id);
    if (!account) throw new NotFoundException('账号不存在');

    const changed: string[] = [];
    if (dto.name !== undefined) { account.name = dto.name.trim(); changed.push('name'); }
    if (dto.weight !== undefined) { account.weight = dto.weight; changed.push('weight'); }
    if (dto.maxInflight !== undefined) { account.maxInflight = dto.maxInflight; changed.push('maxInflight'); }
    if (dto.note !== undefined) { account.note = sanitizeNote(dto.note); changed.push('note'); }
    if (dto.primaryChatId !== undefined) {
      account.primaryChatId = dto.primaryChatId.trim() || null;
      changed.push('primaryChatId');
    }

    if (dto.enabled !== undefined && dto.enabled !== account.enabled) {
      if (dto.enabled) {
        this.assertCanEnable(account);
        account.enabled = true;
        if (account.status === 'disabled') account.status = 'active';
        account.disabledAt = null;
        changed.push('enabled');
      } else {
        account.enabled = false;
        if (account.status === 'active' || account.status === 'degraded' || account.status === 'draining') {
          account.status = 'disabled';
        }
        account.disabledAt = new Date();
        changed.push('disabled');
      }
    }

    account.updatedBy = actorId;
    const saved = await this.repo.save(account);

    if (changed.length > 0) {
      this.audit.log({
        action: dto.enabled === false && changed.includes('disabled')
          ? 'telegram_account_disabled'
          : dto.enabled === true && changed.includes('enabled')
            ? 'telegram_account_enabled'
            : 'telegram_account_updated',
        userId: actorId,
        resourceType: 'telegram_account',
        resourceId: saved.id,
        metadata: { changed, type: saved.type, status: saved.status },
      });
    }
    return toAccountView(saved, { credentialConfigured: Boolean(saved.credentialCiphertext) });
  }

  /**
   * 删除账号 = 撤销参与资格（软删除）。
   *
   * 语义（与产品决策一致）：停止参与新任务、清空加密凭据；**不删除 Telegram 远端
   * 消息与备份**，也不级联删除副本记录（副本由生命周期清理按时间阈值收敛）。
   */
  async remove(id: string, actorId: string): Promise<TelegramAccountView> {
    const account = await this.findWithCredential(id);
    if (!account) throw new NotFoundException('账号不存在');

    account.status = 'revoked';
    account.enabled = false;
    account.disabledAt = account.disabledAt ?? new Date();
    account.credentialCiphertext = null;
    account.credentialVersion = null;
    account.updatedBy = actorId;
    const saved = await this.repo.save(account);

    this.audit.log({
      action: 'telegram_account_deleted',
      userId: actorId,
      resourceType: 'telegram_account',
      resourceId: saved.id,
      metadata: { type: saved.type, externalIdMasked: maskTail(saved.externalId ?? '') },
    });
    return toAccountView(saved, { credentialConfigured: false });
  }

  // ---------------- 轮换 ----------------

  async rotateBot(id: string, dto: RotateBotCredentialDto, actorId: string): Promise<TelegramAccountView> {
    this.assertCryptoAvailable('轮换 Bot 凭据');
    const account = await this.findWithCredential(id);
    if (!account) throw new NotFoundException('账号不存在');
    if (account.type !== 'bot') throw new BadRequestException('该账号不是 Bot 账号');

    const botId = dto.token.split(':')[0];
    // 与 createBot 同一守卫：不得把账号轮换成某个环境变量账号的 Token
    // （否则又会出现「同一 Bot 两个逻辑账号」）；允许用自身当前 Token 做幂等轮换。
    if (botId !== account.externalId && this.pool.isEnvTokenRegistered(dto.token)) {
      throw new ConflictException(
        '该 Bot Token 已由环境变量账号（主 Bot 或账号池配置）注册，后台只读；'
        + '请改用其它 Bot，或先从 .env 移除该账号',
      );
    }
    await this.assertExternalIdFree('bot', botId, account.id);
    const probe = await this.probe.probeBot(dto.token, dto.primaryChatId ?? account.primaryChatId);
    if (!probe.ok) {
      throw new BadRequestException(`新 Token 校验失败，凭据未变更：${probe.error ?? '未知原因'}`);
    }

    const ciphertext = this.credentials.encryptCredential({ token: dto.token });
    if (!ciphertext) throw new BadRequestException('凭据加密不可用，已拒绝以明文保存 Token');

    account.externalId = botId;
    account.credentialCiphertext = ciphertext;
    account.credentialVersion = this.credentials.cipherVersion();
    account.capabilities = probe.capabilities;
    account.lastHealthCheckAt = new Date();
    account.lastSuccessAt = new Date();
    account.lastFailureCode = null;
    account.lastFailureSummary = null;
    if (dto.primaryChatId !== undefined) account.primaryChatId = dto.primaryChatId.trim() || null;
    // 轮换后可恢复 revoked/degraded；但依然保持管理员此前显式停用的 enabled 状态
    if (account.status === 'revoked' || account.status === 'degraded') account.status = 'active';
    account.updatedBy = actorId;
    const saved = await this.repo.save(account);

    this.audit.log({
      action: 'telegram_account_credential_rotated',
      userId: actorId,
      resourceType: 'telegram_account',
      resourceId: saved.id,
      metadata: { type: 'bot', externalIdMasked: maskTail(botId) },
    });
    return toAccountView(saved, { credentialConfigured: true });
  }

  async rotateUser(id: string, dto: RotateUserCredentialDto, actorId: string): Promise<TelegramAccountView> {
    this.assertCryptoAvailable('轮换用户账号凭据');
    const account = await this.findWithCredential(id);
    if (!account) throw new NotFoundException('账号不存在');
    if (account.type !== 'user') throw new BadRequestException('该账号不是用户账号');

    const current = this.decryptPayload(account);
    const apiId = dto.apiId ?? current?.apiId;
    const apiHash = dto.apiHash ?? current?.apiHash;
    const phoneNumber = dto.phoneNumber ?? current?.phoneNumber ?? '';
    if (!apiId || !apiHash) {
      throw new BadRequestException('缺少 API ID / API Hash，无法重新授权');
    }

    const ciphertext = this.credentials.encryptCredential({ apiId, apiHash, phoneNumber });
    if (!ciphertext) throw new BadRequestException('凭据加密不可用，已拒绝以明文保存 API 凭据');

    // 重新授权：旧 session 立即失效，账号回到待授权状态
    account.credentialCiphertext = ciphertext;
    account.credentialVersion = this.credentials.cipherVersion();
    account.status = 'pending_auth';
    account.enabled = false;
    account.externalId = null;
    account.capabilities = null;
    account.updatedBy = actorId;
    const saved = await this.repo.save(account);

    this.audit.log({
      action: 'telegram_account_credential_rotated',
      userId: actorId,
      resourceType: 'telegram_account',
      resourceId: saved.id,
      metadata: { type: 'user', restartAuth: true },
    });
    return toAccountView(saved, { credentialConfigured: true });
  }

  // ---------------- 测试 ----------------

  async test(id: string, actorId: string): Promise<TelegramAccountView> {
    const account = await this.findWithCredential(id);
    if (!account) throw new NotFoundException('账号不存在');

    if (account.type === 'bot') {
      const payload = this.decryptPayload(account);
      if (!payload?.token) {
        await this.recordFailure(account, 'credential_unavailable', '凭据不可解密（根密钥变更或密文损坏）', actorId);
        throw new BadRequestException('凭据不可解密：请轮换 Token 或恢复根密钥');
      }
      const probe = await this.probe.probeBot(payload.token, account.primaryChatId);
      if (probe.ok) {
        account.capabilities = probe.capabilities;
        account.lastHealthCheckAt = new Date();
        account.lastSuccessAt = new Date();
        account.lastFailureCode = null;
        account.lastFailureSummary = null;
        if (account.status === 'degraded') account.status = 'active';
        account.updatedBy = actorId;
        await this.repo.save(account);
        this.audit.log({
          action: 'telegram_account_tested',
          userId: actorId,
          resourceType: 'telegram_account',
          resourceId: account.id,
          metadata: { type: 'bot', ok: true, chatType: probe.chatType },
        });
      } else {
        await this.recordFailure(account, probe.errorCode ?? 'probe_failed', probe.error ?? '测试失败', actorId);
        this.audit.log({
          action: 'telegram_account_tested',
          userId: actorId,
          resourceType: 'telegram_account',
          resourceId: account.id,
          status: AuditStatus.FAILURE,
          metadata: { type: 'bot', ok: false, errorCode: probe.errorCode },
        });
      }
      return this.detail(account.id);
    }

    const payload = this.decryptPayload(account);
    if (!payload?.apiId || !payload.apiHash || !payload.session) {
      await this.recordFailure(account, 'auth_required', '用户账号尚未完成授权（缺少 session）', actorId);
      throw new BadRequestException('用户账号尚未完成授权，请先执行授权流程');
    }
    try {
      const state = await this.userClient.inspect({
        apiId: payload.apiId,
        apiHash: payload.apiHash,
        session: payload.session,
      });
      if (!state.authorized || !state.identity) {
        await this.recordFailure(account, 'session_invalid', 'session 已失效，需要重新授权', actorId);
      } else {
        const capabilities: TelegramAccountCapabilities = { canReadSource: true };
        if (account.primaryChatId) {
          const access = await this.userClient.checkChatAccess(
            { apiId: payload.apiId, apiHash: payload.apiHash, session: payload.session },
            account.primaryChatId,
          );
          capabilities.canWriteMirror = access.canWrite;
        }
        account.capabilities = capabilities;
        account.externalId = state.identity.userId;
        account.lastHealthCheckAt = new Date();
        account.lastSuccessAt = new Date();
        account.lastFailureCode = null;
        account.lastFailureSummary = null;
        if (account.status === 'degraded') account.status = 'active';
        account.updatedBy = actorId;
        await this.repo.save(account);
        this.audit.log({
          action: 'telegram_account_tested',
          userId: actorId,
          resourceType: 'telegram_account',
          resourceId: account.id,
          metadata: {
            type: 'user',
            ok: true,
            externalIdMasked: maskTail(state.identity.userId),
            capabilities,
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordFailure(account, 'session_probe_failed', message, actorId);
      this.audit.log({
        action: 'telegram_account_tested',
        userId: actorId,
        resourceType: 'telegram_account',
        resourceId: account.id,
        status: AuditStatus.FAILURE,
        metadata: { type: 'user', ok: false },
      });
    }
    return this.detail(account.id);
  }

  /**
   * 探测**环境变量账号**（主 Bot 或 `TELEGRAM_ACCOUNT_POOL` 配置项）。
   *
   * 为什么单独一个入口：环境变量账号是只读的（密钥在 `.env`），后台不能编辑/轮换，
   * 但必须能确认「配置是否还有效」——否则主 Bot 探测失败后，管理员只能从日志里猜。
   * 探测结论会回写账号池运行态（健康/冷却），使失败立即影响选号。
   * 响应只回脱敏结论，不含 Token。写操作审计。
   */
  async probeEnvAccount(accountId: string, actorId: string): Promise<EnvAccountProbeResult> {
    const config = this.pool.getConfig(accountId);
    if (!config) throw new NotFoundException('环境变量账号不存在（未在账号池注册）');
    if (config.source === 'panel') {
      throw new BadRequestException('该账号来自数据库，请使用账号测试功能');
    }

    const startedAt = Date.now();
    const probe = await this.probe.probeBot(config.token, config.chatId || null);
    // 探测失败必须立即影响选号：否则界面显示失败但调度器仍在往该账号派活
    this.pool.recordProbe(accountId, probe.ok, Date.now() - startedAt, probe.error ?? undefined);

    this.audit.log({
      action: 'telegram_account_tested',
      userId: actorId,
      resourceType: 'telegram_account',
      resourceId: `env:${accountId}`,
      status: probe.ok ? AuditStatus.SUCCESS : AuditStatus.FAILURE,
      metadata: {
        source: 'env',
        primary: config.primary === true,
        externalIdMasked: maskTail(accountId),
        chatId: config.chatId || null,
        chatType: probe.chatType,
        capabilities: probe.capabilities,
        errorCode: probe.errorCode,
      },
    });

    return {
      ok: probe.ok,
      message: probe.ok ? '环境变量账号探测通过' : (probe.error ?? '环境变量账号探测失败'),
      capabilities: probe.capabilities,
      chatTitle: probe.chatTitle,
      chatType: probe.chatType,
      errorCode: probe.errorCode,
    };
  }

  // ---------------- 供账号池 / 镜像使用 ----------------

  /**
   * 解析参与调度的 Bot 账号（解密后的凭据只在本进程内存中使用）。
   * 只返回 `enabled` 且状态为 active/degraded 的 Bot 账号。
   */
  async resolveEnabledBotAccounts(): Promise<PoolBotAccount[]> {
    const rows = await this.repo.createQueryBuilder('account')
      .addSelect('account.credentialCiphertext')
      .where('account.type = :type', { type: 'bot' })
      .andWhere('account.enabled = :enabled', { enabled: true })
      .andWhere('account.status IN (:...statuses)', { statuses: ['active', 'degraded'] })
      .getMany();

    const result: PoolBotAccount[] = [];
    for (const account of rows) {
      const payload = this.decryptPayload(account);
      if (!payload?.token || !account.externalId) {
        // 凭据不可解密：不参与调度，并降级标记（不抛异常，避免影响其它账号）
        this.logger.warn(`账号 ${account.id} 凭据不可解密，已跳过参与调度`);
        continue;
      }
      result.push({
        id: account.id,
        accountId: account.externalId,
        token: payload.token,
        chatId: account.primaryChatId ?? '',
        weight: Number(account.weight) || 1,
        maxInflight: Number(account.maxInflight) || 8,
      });
    }
    return result;
  }

  /** 解析单个账号的解密凭据（供镜像执行；调用方负责不落日志） */
  async resolveCredential(id: string): Promise<{ account: TelegramAccount; payload: TelegramAccountCredentialPayload } | null> {
    const account = await this.findWithCredential(id);
    if (!account) return null;
    const payload = this.decryptPayload(account);
    if (!payload) return null;
    return { account, payload };
  }

  async findById(id: string): Promise<TelegramAccount | null> {
    return this.repo.findOne({ where: { id } });
  }

  /** 按外部标识查找账号（镜像任务需要把 botId 映射回账号记录） */
  async findByExternalId(type: 'bot' | 'user', externalId: string): Promise<TelegramAccount | null> {
    return this.repo.findOne({ where: { type, externalId } });
  }

  /**
   * 解析可用的用户账号（含解密后的 session）。
   * 只返回 `enabled` 且状态为 active/degraded 的用户账号；凭据不可解密的跳过。
   */
  async resolveEnabledUserAccounts(): Promise<Array<{
    id: string;
    externalId: string;
    apiId: number;
    apiHash: string;
    session: string;
    primaryChatId: string | null;
    weight: number;
    capabilities: TelegramAccountCapabilities | null;
  }>> {
    const rows = await this.repo.createQueryBuilder('account')
      .addSelect('account.credentialCiphertext')
      .where('account.type = :type', { type: 'user' })
      .andWhere('account.enabled = :enabled', { enabled: true })
      .andWhere('account.status IN (:...statuses)', { statuses: ['active', 'degraded'] })
      .getMany();

    const result: Array<{
      id: string;
      externalId: string;
      apiId: number;
      apiHash: string;
      session: string;
      primaryChatId: string | null;
      weight: number;
      capabilities: TelegramAccountCapabilities | null;
    }> = [];
    for (const account of rows) {
      const payload = this.decryptPayload(account);
      if (!payload?.apiId || !payload.apiHash || !payload.session || !account.externalId) {
        this.logger.warn(`用户账号 ${account.id} 凭据不完整或不可解密，已跳过镜像调度`);
        continue;
      }
      result.push({
        id: account.id,
        externalId: account.externalId,
        apiId: payload.apiId,
        apiHash: payload.apiHash,
        session: payload.session,
        primaryChatId: account.primaryChatId ?? null,
        weight: Number(account.weight) || 1,
        capabilities: account.capabilities ?? null,
      });
    }
    return result;
  }

  /** 把账号标记为降级（能力缺失/连续失败），不覆盖 revoked/disabled/pending_auth */
  async markDegraded(id: string, code: string, summary: string): Promise<void> {
    const account = await this.repo.findOne({ where: { id } });
    if (!account) return;
    if (account.status === 'active') account.status = 'degraded';
    account.lastFailureAt = new Date();
    account.lastFailureCode = code.slice(0, 64);
    account.lastFailureSummary = summary.slice(0, FAILURE_SUMMARY_LIMIT);
    await this.repo.save(account);
  }

  /**
   * 用户账号授权成功后的落库（由 `TelegramUserAuthService` 调用）。
   * 只保存**加密后的 session**，身份标识脱敏可见，能力快照来自授权后的真实探测。
   */
  async completeUserAuthorization(
    id: string,
    input: { session: string; identity: { userId: string; username: string | null }; capabilities: TelegramAccountCapabilities },
    actorId: string,
  ): Promise<TelegramAccountView> {
    this.assertCryptoAvailable('保存用户账号 session');
    const account = await this.findWithCredential(id);
    if (!account) throw new NotFoundException('账号不存在');
    if (account.type !== 'user') throw new BadRequestException('该账号不是用户账号');

    await this.assertExternalIdFree('user', input.identity.userId, account.id);
    const payload = this.decryptPayload(account);
    const ciphertext = this.credentials.encryptCredential({
      apiId: payload?.apiId,
      apiHash: payload?.apiHash,
      phoneNumber: payload?.phoneNumber ?? '',
      session: input.session,
    });
    if (!ciphertext) throw new BadRequestException('凭据加密不可用，已拒绝以明文保存 session');

    account.credentialCiphertext = ciphertext;
    account.credentialVersion = this.credentials.cipherVersion();
    account.externalId = input.identity.userId;
    account.status = 'active';
    account.enabled = true;
    account.capabilities = input.capabilities;
    account.lastHealthCheckAt = new Date();
    account.lastSuccessAt = new Date();
    account.lastFailureCode = null;
    account.lastFailureSummary = null;
    account.updatedBy = actorId;
    const saved = await this.repo.save(account);

    this.audit.log({
      action: 'telegram_account_auth_succeeded',
      userId: actorId,
      resourceType: 'telegram_account',
      resourceId: saved.id,
      metadata: {
        type: 'user',
        externalIdMasked: maskTail(input.identity.userId),
        username: input.identity.username,
        capabilities: input.capabilities,
      },
    });
    return toAccountView(saved, { credentialConfigured: true });
  }

  /** 记录授权失败（不改凭据，只记录可诊断信息） */
  async recordAuthFailure(id: string, code: string, summary: string, actorId: string): Promise<void> {
    const account = await this.repo.findOne({ where: { id } });
    if (!account) return;
    await this.recordFailure(account, code, summary, actorId);
  }

  // ---------------- 内部 ----------------

  private async findWithCredential(id: string): Promise<TelegramAccount | null> {
    return this.repo.createQueryBuilder('account')
      .addSelect('account.credentialCiphertext')
      .where('account.id = :id', { id })
      .getOne();
  }

  private decryptPayload(account: TelegramAccount): TelegramAccountCredentialPayload | null {
    return this.credentials.decryptCredential<TelegramAccountCredentialPayload>(account.credentialCiphertext);
  }

  private assertCryptoAvailable(action: string): void {
    if (!this.credentials.isAvailable()) {
      throw new BadRequestException(
        `${action}失败：未配置 TELEGRAM_ACCOUNT_ENCRYPTION_KEY（32 字节 base64/hex），`
        + '凭据无法加密保存，已拒绝以明文落库',
      );
    }
  }

  private assertCanEnable(account: TelegramAccount): void {
    if (account.status === 'revoked') {
      throw new BadRequestException('账号已撤销，需先轮换凭据后才能启用');
    }
    if (account.status === 'pending_auth') {
      throw new BadRequestException('用户账号尚未完成授权，无法启用');
    }
    if (!account.credentialCiphertext) {
      throw new BadRequestException('账号凭据缺失（可能已被删除），请先轮换凭据');
    }
  }

  private async assertExternalIdFree(type: 'bot' | 'user', externalId: string, exceptId?: string): Promise<void> {
    const existing = await this.repo.findOne({ where: { type, externalId } });
    if (existing && existing.id !== exceptId) {
      throw new ConflictException(
        `${type === 'bot' ? 'Bot' : 'Telegram 用户'} ${maskTail(externalId)} 已存在，不允许重复登记`,
      );
    }
  }

  private async recordFailure(
    account: TelegramAccount,
    code: string,
    summary: string,
    actorId: string,
  ): Promise<void> {
    if (account.status === 'active') account.status = 'degraded';
    account.lastHealthCheckAt = new Date();
    account.lastFailureAt = new Date();
    account.lastFailureCode = code.slice(0, 64);
    account.lastFailureSummary = summary.slice(0, FAILURE_SUMMARY_LIMIT);
    account.updatedBy = actorId;
    await this.repo.save(account);
  }
}

/** 备注脱敏：去掉控制字符与多余空白，限制长度（避免审计里塞入奇形内容） */
function sanitizeNote(note: string | undefined): string | null {
  if (note === undefined) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = note.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 255) : null;
}

function maskTail(value: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 4) return '***';
  return `***${trimmed.slice(-4)}`;
}
