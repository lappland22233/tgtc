import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import { ApiKey } from '../common/entities/api-key.entity';
import { ApiKeyIpAllowlist } from '../common/entities/api-key-ip-allowlist.entity';
import { ApiKeyUsageResult } from '../common/entities/api-key-usage-log.entity';
import { User } from '../common/entities/user.entity';
import { attachApiKeyContext } from '../common/auth-context';
import { AuditService } from '../common/services/audit.service';
import { ipInAllowlist, parseIpRule } from '../common/utils/ip-allowlist';
import { ApiKeyCryptoService } from './api-key-crypto.service';
import { ApiKeyUsageService } from './api-key-usage.service';

/** 明文密钥前缀，标识本系统签发的 API 密钥 */
const API_KEY_SECRET_PREFIX = 'tgtc';
/** 单账号同时有效的密钥数量上限（防滥用） */
export const MAX_API_KEYS_PER_USER = 20;
/** lastUsedAt 节流窗口：窗口内重复认证不重复写库 */
const LAST_USED_UPDATE_INTERVAL_MS = 60 * 1000;
/** 单把密钥 IP 白名单规则数上限 */
export const MAX_IP_RULES_PER_KEY = 50;

/** 创建/轮换密钥的响应：明文 key 仅出现这一次（此后可凭所有者身份重显） */
export interface CreatedApiKey {
  id: string;
  name: string;
  prefix: string;
  key: string;
  createdAt: Date;
}

/** 列表响应：仅元信息，绝不含摘要/密文/明文 */
export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  /** 是否支持所有者重显明文（v1.2.6 起创建的密钥为 true；历史密钥需轮换） */
  revealable: boolean;
}

@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(
    @InjectRepository(ApiKey)
    private readonly apiKeyRepository: Repository<ApiKey>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(ApiKeyIpAllowlist)
    private readonly allowlistRepository: Repository<ApiKeyIpAllowlist>,
    private readonly auditService: AuditService,
    private readonly cryptoService: ApiKeyCryptoService,
    private readonly usageService: ApiKeyUsageService,
  ) {}

  private hashKey(rawKey: string): string {
    return createHash('sha256').update(rawKey, 'utf8').digest('hex');
  }

  /** 所有登录用户均可创建密钥；仅关联自身账号。 */
  async create(user: User, name?: string): Promise<CreatedApiKey> {
    const trimmedName = (name || '').trim() || '默认密钥';

    const activeCount = await this.apiKeyRepository.count({
      where: { userId: user.id, revokedAt: IsNull() },
    });
    if (activeCount >= MAX_API_KEYS_PER_USER) {
      throw new BadRequestException(
        `每个账号最多同时持有 ${MAX_API_KEYS_PER_USER} 个有效 API 密钥，请先撤销不再使用的密钥`,
      );
    }

    const rawKey = `${API_KEY_SECRET_PREFIX}_${randomBytes(32).toString('base64url')}`;
    // v1.2.6：明文 AES-256-GCM 加密保存，供所有者在登录会话中重显；
    // 加密服务不可用（未配置根密钥）时退化为历史行为（不可重显）。
    const keyCipher = this.cryptoService.encrypt(rawKey);
    const entity = await this.apiKeyRepository.save(
      this.apiKeyRepository.create({
        userId: user.id,
        name: trimmedName.slice(0, 64),
        prefix: rawKey.slice(0, 14),
        keyHash: this.hashKey(rawKey),
        keyCipher,
        cipherVersion: keyCipher ? 'v1' : null,
      }),
    );

    this.auditService.log({
      action: 'api_key_create' as never,
      userId: user.id,
      resourceType: 'api_key',
      resourceId: entity.id,
      metadata: { prefix: entity.prefix, name: entity.name, revealable: !!keyCipher },
    } as never);

    return {
      id: entity.id,
      name: entity.name,
      prefix: entity.prefix,
      key: rawKey,
      createdAt: entity.createdAt,
    };
  }

  async list(user: User): Promise<ApiKeySummary[]> {
    const keys = await this.apiKeyRepository.find({
      where: { userId: user.id },
      order: { createdAt: 'DESC' },
    });
    return keys.map((key) => ({
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      revokedAt: key.revokedAt,
      revealable: !!key.keyCipher,
    }));
  }

  /**
   * 所有者重显完整明文（v1.2.6）。
   * 仅接受 JWT 登录会话（控制器层保证），仅限密钥所有者本人；
   * 管理员无越权通道；历史密钥（仅存 hash）不可重显，提示轮换。
   */
  async reveal(user: User, id: string): Promise<{ key: string }> {
    const key = await this.apiKeyRepository.findOne({ where: { id } });
    if (!key || key.userId !== user.id) {
      throw new NotFoundException('API 密钥不存在');
    }
    if (!key.keyCipher) {
      throw new BadRequestException('此密钥创建于旧版本，无法回显明文；请轮换密钥以启用回显');
    }
    if (key.revokedAt) {
      throw new BadRequestException('密钥已撤销，无法回显');
    }
    const plaintext = this.cryptoService.decrypt(key.keyCipher);
    if (!plaintext) {
      // 根密钥丢失/轮换导致解密失败：不泄露任何细节，提示轮换
      throw new BadRequestException('密钥解密失败（加密密钥可能已变更），请轮换此密钥');
    }

    this.auditService.log({
      action: 'api_key_reveal' as never,
      userId: user.id,
      resourceType: 'api_key',
      resourceId: key.id,
      metadata: { prefix: key.prefix },
    } as never);

    return { key: plaintext };
  }

  /** 撤销即时生效（authenticate 按 revokedAt 过滤）。重复撤销幂等。 */
  async revoke(user: User, id: string): Promise<void> {
    const key = await this.apiKeyRepository.findOne({ where: { id } });
    if (!key || key.userId !== user.id) {
      // 不区分「不存在」与「属于他人」，避免泄露其他账号的密钥信息
      throw new NotFoundException('API 密钥不存在');
    }
    if (key.revokedAt) return;

    await this.apiKeyRepository.update(id, { revokedAt: new Date() });
    this.auditService.log({
      action: 'api_key_revoke' as never,
      userId: user.id,
      resourceType: 'api_key',
      resourceId: key.id,
      metadata: { prefix: key.prefix },
    } as never);
  }

  /** 轮换：撤销旧密钥并创建同名新密钥；新明文仅返回一次。 */
  async rotate(user: User, id: string, name?: string): Promise<CreatedApiKey> {
    const key = await this.apiKeyRepository.findOne({ where: { id } });
    if (!key || key.userId !== user.id) {
      throw new NotFoundException('API 密钥不存在');
    }
    if (key.revokedAt) {
      throw new BadRequestException('密钥已撤销，无法轮换，请直接创建新密钥');
    }
    await this.revoke(user, id);
    return this.create(user, name ?? key.name);
  }

  // ---------- IP 白名单（每把密钥独立配置） ----------

  /** 查询密钥的 IP 白名单规则（仅所有者） */
  async getAllowlist(user: User, id: string): Promise<{ rules: string[] }> {
    const key = await this.apiKeyRepository.findOne({ where: { id } });
    if (!key || key.userId !== user.id) {
      throw new NotFoundException('API 密钥不存在');
    }
    const rows = await this.allowlistRepository.find({
      where: { apiKeyId: id },
      order: { createdAt: 'ASC' },
    });
    return { rules: rows.map((row) => row.rule) };
  }

  /** 全量替换密钥的 IP 白名单（仅所有者；空数组 = 清空 = 不限制来源） */
  async setAllowlist(user: User, id: string, rules: string[]): Promise<{ rules: string[] }> {
    await this.usageService.assertKeyOwnedForMutation(user, id);

    // 校验并规范化规则；非法规则直接拒绝（不静默忽略，避免「以为配了白名单实际没生效」）
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const raw of rules) {
      const parsed = parseIpRule(raw);
      if (!parsed.ok) {
        throw new BadRequestException(`IP 规则非法（${raw}）：${parsed.error}`);
      }
      if (!seen.has(parsed.normalized)) {
        seen.add(parsed.normalized);
        normalized.push(parsed.normalized);
      }
    }
    if (normalized.length > MAX_IP_RULES_PER_KEY) {
      throw new BadRequestException(`每把密钥最多配置 ${MAX_IP_RULES_PER_KEY} 条 IP 规则`);
    }

    await this.apiKeyRepository.manager.transaction(async (manager) => {
      await manager.getRepository(ApiKeyIpAllowlist).delete({ apiKeyId: id });
      if (normalized.length > 0) {
        await manager
          .getRepository(ApiKeyIpAllowlist)
          .insert(normalized.map((rule) => ({ apiKeyId: id, rule })));
      }
    });

    this.auditService.log({
      action: 'api_key_allowlist_update' as never,
      userId: user.id,
      resourceType: 'api_key',
      resourceId: id,
      metadata: { ruleCount: normalized.length },
    } as never);

    return { rules: normalized };
  }

  /**
   * 认证 API Key：摘要查找 → 撤销检查 → 账号状态检查 → IP 白名单检查。
   * 返回附带 API Key 上下文（owner-only 标记）的用户对象。
   *
   * @param rawKey 明文密钥
   * @param ip 可信客户端 IP（Guard 传入）；白名单非空且 IP 无法判定时 fail-closed 拒绝
   */
  async authenticate(rawKey: string, ip?: string | null): Promise<User> {
    const keyHash = this.hashKey(rawKey);
    const apiKey = await this.apiKeyRepository.findOne({ where: { keyHash } });
    if (!apiKey || apiKey.revokedAt) {
      throw new UnauthorizedException('无效或已撤销的 API 密钥');
    }

    const user = await this.userRepository.findOne({ where: { id: apiKey.userId } });
    if (!user) {
      throw new UnauthorizedException('API 密钥关联的账号不存在');
    }
    if (user.isBanned) {
      throw new UnauthorizedException('账号已被封禁');
    }

    // 与 JWT 语义对齐：密码变更后，早于变更时间创建的密钥一并失效
    // （用户怀疑密钥泄露时的标准动作是改密码，期望所有旧凭证同时失效）。
    if (user.passwordUpdatedAt && apiKey.createdAt && apiKey.createdAt < user.passwordUpdatedAt) {
      throw new UnauthorizedException('账号密码已变更，此 API 密钥已失效，请重新创建');
    }

    // v1.2.6：每把密钥独立的 IP 白名单。非空名单且不命中（含 IP 不可判定）即拒绝；
    // 拒绝不暴露密钥有效性细节，并直接记录 denied_ip 使用日志。
    const allowlistRules = await this.allowlistRepository.find({
      where: { apiKeyId: apiKey.id },
    });
    if (allowlistRules.length > 0 && !ipInAllowlist(ip ?? '', allowlistRules.map((r) => r.rule))) {
      this.usageService.record({
        apiKeyId: apiKey.id,
        userId: apiKey.userId,
        method: 'AUTH',
        route: 'ip_allowlist_check',
        result: ApiKeyUsageResult.DENIED_IP,
        statusCode: 401,
        ip: ip || '',
      });
      throw new UnauthorizedException('该 API 密钥不允许此来源 IP 访问');
    }

    // lastUsedAt 节流更新；失败只记日志，不影响请求
    const now = Date.now();
    if (!apiKey.lastUsedAt || now - apiKey.lastUsedAt.getTime() > LAST_USED_UPDATE_INTERVAL_MS) {
      this.apiKeyRepository
        .update(apiKey.id, { lastUsedAt: new Date() })
        .catch((error: unknown) => {
          this.logger.warn(
            `更新 API 密钥最近使用时间失败: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }

    return attachApiKeyContext(user, {
      keyId: apiKey.id,
      keyName: apiKey.name,
      prefix: apiKey.prefix,
    });
  }
}
