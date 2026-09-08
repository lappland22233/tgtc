import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { ApiKeyService } from './api-key.service';
import { getClientIp } from '../common/utils/client-ip';

/**
 * 组合认证 Guard：X-API-Key 显式优先，否则走 JWT（Cookie / Bearer）。
 *
 * - 请求头携带非空 X-API-Key 时走 API Key 认证（owner-only 上下文，
 *   见 auth-context.ts）；认证失败直接 401，**不回退 JWT**（fail-closed，
 *   防止"无效密钥静默降级为他人 JWT"的凭据混淆）；
 * - 未携带 X-API-Key 的请求沿用原 JWT 链路（含失败日志与统一 401 语义，
 *   与 JwtAuthGuard 一致）。
 */
@Injectable()
export class JwtOrApiKeyAuthGuard extends AuthGuard('jwt') implements CanActivate {
  private readonly logger = new Logger(JwtOrApiKeyAuthGuard.name);

  constructor(private readonly apiKeyService: ApiKeyService) {
    super();
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = request?.headers?.['x-api-key'];
    const rawKey = typeof header === 'string' ? header.trim() : '';

    if (rawKey) {
      const clientIp = getClientIp(request);
      return this.apiKeyService
        .authenticate(rawKey, clientIp)
        .then((user) => {
          request.user = user;
          return true;
        })
        .catch((error: unknown) => {
          this.logWarn(error, request);
          throw this.toUnauthorized(error);
        });
    }

    // JWT 链路（复用 passport 'jwt' 策略）
    try {
      const result = super.canActivate(context);
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          this.logWarn(error, request);
          throw this.toUnauthorized(error);
        });
      }
      return result;
    } catch (error) {
      this.logWarn(error, request);
      throw this.toUnauthorized(error);
    }
  }

  private toUnauthorized(error: unknown): UnauthorizedException {
    if (error instanceof UnauthorizedException) {
      return error;
    }
    return new UnauthorizedException('认证失败');
  }

  private logWarn(error: unknown, request: any): void {
    const ip = getClientIp(request) || 'unknown';
    const msg = error instanceof Error ? error.message : String(error);
    this.logger.warn(`认证失败 [${ip}]（JWT 或 API Key）: ${msg}`);
  }
}
