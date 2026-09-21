import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TelegramAccountCapabilities } from '../common/entities/telegram-account.entity';
import { AuditStatus } from '../common/entities/audit-log.entity';
import { AuditService } from '../common/services/audit.service';
import { TelegramUserClientService } from '../telegram-user/telegram-user-client.service';
import { TelegramAccountsService } from './telegram-accounts.service';
import { StartUserAuthDto, VerifyUserAuthDto } from './telegram-account.dto';
import { maskPhoneNumber } from './telegram-account-view';

/** 授权会话有效期：超过后必须重新发送验证码 */
const AUTH_SESSION_TTL_MS = 10 * 60 * 1000;

interface PendingAuthSession {
  accountId: string;
  phoneNumber: string;
  phoneCodeHash: string;
  /** 中间态 session（未授权），提交验证码时必须复用 */
  session: string;
  apiId: number;
  apiHash: string;
  createdAt: number;
}

export interface StartAuthResult {
  phoneMasked: string | null;
  isCodeViaApp: boolean;
  expiresAt: string;
}

/**
 * Telegram 用户账号交互式授权。
 *
 * 安全约束（与 `.codebuddy/待更新.md` §5.3 一致）：
 * - **不接受把 session 明文粘贴到普通表单长期保存**：session 只能由服务端交互式授权产生；
 * - 验证码与 2FA 密码只在内存中参与一次调用：**不入库、不入日志、不进审计 metadata**；
 * - 授权成功后只保存加密 session；
 * - 中间态（phoneCodeHash / 未授权 session）放在**进程内**并带 TTL：
 *   项目已声明只支持单后端实例，重启后授权需要重来，这是可接受的代价（不会泄漏凭据）。
 */
@Injectable()
export class TelegramUserAuthService {
  private readonly logger = new Logger(TelegramUserAuthService.name);
  private readonly pending = new Map<string, PendingAuthSession>();

  constructor(
    private readonly accounts: TelegramAccountsService,
    private readonly userClient: TelegramUserClientService,
    private readonly audit: AuditService,
  ) {}

  /** 发送登录验证码（验证码只发到用户自己的 Telegram 客户端） */
  async start(id: string, dto: StartUserAuthDto, actorId: string): Promise<StartAuthResult> {
    const resolved = await this.accounts.resolveCredential(id);
    if (!resolved) throw new NotFoundException('账号不存在或凭据不可解密');
    const { account, payload } = resolved;
    if (account.type !== 'user') throw new BadRequestException('该账号不是用户账号');
    if (!payload.apiId || !payload.apiHash) {
      throw new BadRequestException('缺少 API ID / API Hash，请先轮换凭据');
    }
    if (!this.userClient.isAvailable()) {
      throw new BadRequestException(
        `MTProto 客户端不可用（${this.userClient.unavailableReason() ?? '依赖未安装'}），无法发起授权`,
      );
    }

    const phoneNumber = (dto.phoneNumber ?? payload.phoneNumber ?? '').trim();
    if (!phoneNumber) throw new BadRequestException('缺少手机号（需带国家码，如 +8613800000000）');

    try {
      const result = await this.userClient.sendLoginCode(
        { apiId: payload.apiId, apiHash: payload.apiHash, session: payload.session ?? '' },
        phoneNumber,
        dto.forceSMS === true,
      );
      const createdAt = Date.now();
      this.pending.set(id, {
        accountId: id,
        phoneNumber,
        phoneCodeHash: result.phoneCodeHash,
        session: result.session,
        apiId: payload.apiId,
        apiHash: payload.apiHash,
        createdAt,
      });
      this.sweepExpired(createdAt);

      this.audit.log({
        action: 'telegram_account_auth_started',
        userId: actorId,
        resourceType: 'telegram_account',
        resourceId: id,
        metadata: {
          phoneMasked: maskPhoneNumber(phoneNumber),
          isCodeViaApp: result.isCodeViaApp,
        },
      });
      return {
        phoneMasked: maskPhoneNumber(phoneNumber),
        isCodeViaApp: result.isCodeViaApp,
        expiresAt: new Date(createdAt + AUTH_SESSION_TTL_MS).toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.accounts.recordAuthFailure(id, 'auth_send_code_failed', message, actorId);
      throw new BadRequestException(`发送验证码失败：${message}`);
    }
  }

  /** 提交验证码（如需两步验证密码一并提交） */
  async verify(id: string, dto: VerifyUserAuthDto, actorId: string): Promise<{ ok: boolean; status: string }> {
    const pending = this.pending.get(id);
    if (!pending) throw new BadRequestException('授权会话不存在或已过期，请重新发送验证码');
    if (Date.now() - pending.createdAt > AUTH_SESSION_TTL_MS) {
      this.pending.delete(id);
      throw new BadRequestException('授权会话已过期，请重新发送验证码');
    }

    try {
      const authorized = await this.userClient.signIn({
        credentials: { apiId: pending.apiId, apiHash: pending.apiHash, session: pending.session },
        phoneNumber: pending.phoneNumber,
        phoneCodeHash: pending.phoneCodeHash,
        code: dto.code,
        password: dto.password,
      });

      const capabilities: TelegramAccountCapabilities = { canReadSource: true };
      const resolved = await this.accounts.resolveCredential(id);
      if (resolved?.account.primaryChatId) {
        try {
          const access = await this.userClient.checkChatAccess(
            { apiId: pending.apiId, apiHash: pending.apiHash, session: authorized.session },
            resolved.account.primaryChatId,
          );
          capabilities.canWriteMirror = access.canWrite;
        } catch (error) {
          // 源/目标 Chat 权限探测失败不阻断授权本身，但能力快照保持 canWriteMirror=false
          this.logger.warn(
            `授权后 Chat 权限探测失败（账号 ${id}）：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const view = await this.accounts.completeUserAuthorization(
        id,
        { session: authorized.session, identity: authorized.identity, capabilities },
        actorId,
      );
      this.pending.delete(id);
      return { ok: true, status: view.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.accounts.recordAuthFailure(id, 'auth_verify_failed', message, actorId);
      this.audit.log({
        action: 'telegram_account_auth_failed',
        userId: actorId,
        resourceType: 'telegram_account',
        resourceId: id,
        status: AuditStatus.FAILURE,
        // 只记录分类原因，绝不记录用户输入的验证码/密码
        metadata: { reason: message.slice(0, 200) },
      });
      throw new BadRequestException(`授权失败：${message}`);
    }
  }

  /** 取消授权会话（清理进程内中间态） */
  cancel(id: string): { ok: boolean } {
    const existed = this.pending.delete(id);
    return { ok: existed };
  }

  private sweepExpired(now: number): void {
    for (const [key, session] of this.pending.entries()) {
      if (now - session.createdAt > AUTH_SESSION_TTL_MS) this.pending.delete(key);
    }
  }
}
