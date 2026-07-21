import { Injectable, ExecutionContext, Logger, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { getClientIp } from '../utils/client-ip';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest();
    try {
      const result = super.canActivate(context);
      // 如果返回 Promise 且失败，则捕获并记录日志，再以 401 抛出（而非返回 false 触发 403）
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          this.logWarn(error, request);
          throw this.toUnauthorized(error);
        });
      }
      return result;
    } catch (error: unknown) {
      this.logWarn(error, request);
      throw this.toUnauthorized(error);
    }
  }

  /** 统一转换为 401；保留原始 UnauthorizedException，其余错误用通用消息避免泄漏内部细节 */
  private toUnauthorized(error: unknown): UnauthorizedException {
    if (error instanceof UnauthorizedException) {
      return error;
    }
    return new UnauthorizedException('认证失败');
  }

  private logWarn(error: unknown, request: any): void {
    const ip = getClientIp(request) || 'unknown';
    const userAgent = (request.headers?.['user-agent'] as string)?.substring(0, 200) || 'unknown';
    const msg = error instanceof Error ? error.message : String(error);
    this.logger.warn(`JWT 认证失败 [${ip} UA:${userAgent}]: ${msg}`);
  }
}
