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
import { User } from '../common/entities/user.entity';
import { attachApiKeyContext } from '../common/auth-context';
import { AuditService } from '../common/services/audit.service';
import { AuditAction } from '../common/entities/audit-log.entity';

/** 明文密钥前缀，标识本系统签发的 API 密钥 */
const API_KEY_SECRET_PREFIX = 'tgtc';
/** 单账号同时有效的密钥数量上限（防滥用） */
export const MAX_API_KEYS_PER_USER = 20;
/** lastUsedAt 节流窗口：窗口内重复认证不重复写库 */
const LAST_USED_UPDATE_INTERVAL_MS = 60 * 1000;

/** 创建/轮换密钥的响应：明文 key 仅出现这一次 */
export interface CreatedApiKey {
  id: string;
  name: string;
  prefix: string;
  key: string;
  createdAt: Date;
}

/** 列表响应：仅元信息，绝不含摘要/明文 */
export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(
    @InjectRepository(ApiKey)
    private readonly apiKeyRepository: Repository<ApiKey>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly auditService: AuditService,
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
    const entity = await this.apiKeyRepository.save(
      this.apiKeyRepository.create({
        userId: user.id,
        name: trimmedName.slice(0, 64),
        prefix: rawKey.slice(0, 14),
        keyHash: this.hashKey(rawKey),
      }),
    );

    this.auditService.log({
      action: 'api_key_create' as AuditAction,
      userId: user.id,
      resourceType: 'api_key',
      resourceId: entity.id,
      metadata: { prefix: entity.prefix, name: entity.name },
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
    }));
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
      action: 'api_key_revoke' as AuditAction,
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

  /**
   * 认证 API Key：摘要查找 → 撤销检查 → 账号状态检查。
   * 返回附带 API Key 上下文（owner-only 标记）的用户对象。
   */
  async authenticate(rawKey: string): Promise<User> {
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
