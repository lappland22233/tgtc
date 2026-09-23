import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TelegramAccount,
  TelegramAccountCapabilities,
} from '../common/entities/telegram-account.entity';
import { TelegramAccountCredentialService } from '../telegram-accounts/telegram-account-credential.service';

/** 用户账号凭据载荷（与 `TelegramAccountsService` 落库形状一致；明文只在内存中出现） */
export interface TelegramUserCredentialPayload {
  apiId?: number;
  apiHash?: string;
  session?: string;
}

/** 可供中继使用的用户账号（凭据已解密；**禁止**写入日志/审计/接口响应） */
export interface RelayUserAccount {
  /** `telegram_accounts.id`（账号主数据 ID，用于降级标记） */
  id: string;
  /** Telegram 用户 ID（外部标识，用于审计展示） */
  externalId: string;
  apiId: number;
  apiHash: string;
  session: string;
  /** 可选源 Chat 配置（用户账号语义，非必填） */
  primaryChatId: string | null;
  weight: number;
  capabilities: TelegramAccountCapabilities | null;
}

/** 账号列表缓存 TTL：中继是低频操作，无需每次转发都查库 */
const CACHE_TTL_MS = 60_000;
const FAILURE_SUMMARY_LIMIT = 500;

/**
 * 用户账号目录（账号池视角的用户账号事实来源）。
 *
 * 为什么账号池不能直接注入 `TelegramAccountsService`：
 * `TelegramAccountsModule` 已经 import `TelegramAccountPoolModule`（见其模块注释
 * 「反向依赖由账号池模块直接注入实体仓库完成」），若账号池反向 import 账号管理模块
 * 就会形成环。因此这里按既有约定**直接注入实体仓库**读取账号，并复用叶子模块
 * `TelegramAccountCredentialModule` 解密 session，零循环、零 `forwardRef`。
 *
 * 与 `TelegramAccountsService.resolveEnabledUserAccounts()` / `markDegraded()` 的
 * 语义对齐（同一取数条件、同一降级规则）；改动其中一处时必须同步另一处。
 */
@Injectable()
export class UserAccountDirectoryService {
  private readonly logger = new Logger(UserAccountDirectoryService.name);
  private cache: RelayUserAccount[] = [];
  private cacheAtMs = 0;
  private loading: Promise<RelayUserAccount[]> | null = null;

  constructor(
    @InjectRepository(TelegramAccount)
    private readonly repo: Repository<TelegramAccount>,
    private readonly credentials: TelegramAccountCredentialService,
  ) {}

  /**
   * 解析可用的用户账号（含解密后的 session）。
   * 只返回 `enabled` 且状态为 active/degraded 的用户账号；凭据不可解密的跳过。
   *
   * 结果带短 TTL 缓存：中继失败/冷却重试会在短时间内重复调用，不该每次都打库。
   */
  async listEnabled(force = false): Promise<RelayUserAccount[]> {
    const fresh = Date.now() - this.cacheAtMs < CACHE_TTL_MS;
    if (!force && fresh) return this.cache;
    if (this.loading) return this.loading;
    this.loading = this.load()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`用户账号目录读取失败（将沿用上一次结果）：${message}`);
        return this.cache;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /** 同步读取最近一次解析到的账号数量（供 `isConfigured()` 这类同步判定使用） */
  cachedCount(): number {
    return this.cache.length;
  }

  /**
   * 把账号标记为降级（凭据失效/能力缺失）。
   * 与 `TelegramAccountsService.markDegraded` 同规则：不覆盖 revoked/disabled/pending_auth。
   */
  async markDegraded(id: string, code: string, summary: string): Promise<void> {
    try {
      const account = await this.repo.findOne({ where: { id } });
      if (!account) return;
      if (account.status === 'active') account.status = 'degraded';
      account.lastFailureAt = new Date();
      account.lastFailureCode = code.slice(0, 64);
      account.lastFailureSummary = summary.slice(0, FAILURE_SUMMARY_LIMIT);
      await this.repo.save(account);
      // 状态已变：让下一次解析重新取数，让新状态（如已 enabled=false 的账号被摘除）立即生效。
      // 注意 `degraded` 仍属可调度状态（取数条件为 active|degraded），因此这一步不会把
      // 「刚降级的账号」移出候选——降级语义是「可用但已被观测到失败」，改语义需先改取数条件。
      this.cacheAtMs = 0;
    } catch (error) {
      this.logger.warn(
        `用户账号 ${id} 降级标记失败（忽略）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async load(): Promise<RelayUserAccount[]> {
    const rows = await this.repo.createQueryBuilder('account')
      .addSelect('account.credentialCiphertext')
      .where('account.type = :type', { type: 'user' })
      .andWhere('account.enabled = :enabled', { enabled: true })
      .andWhere('account.status IN (:...statuses)', { statuses: ['active', 'degraded'] })
      .getMany();

    const result: RelayUserAccount[] = [];
    for (const account of rows) {
      const payload = this.credentials.decryptCredential<TelegramUserCredentialPayload>(
        account.credentialCiphertext,
      );
      if (!payload?.apiId || !payload.apiHash || !payload.session || !account.externalId) {
        this.logger.warn(`用户账号 ${account.id} 凭据不完整或不可解密，已跳过中继调度`);
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
    this.cache = result;
    this.cacheAtMs = Date.now();
    return result;
  }
}
